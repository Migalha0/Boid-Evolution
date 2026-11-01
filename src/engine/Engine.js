import { BOID_COLORS, GpuBoidSim } from '../gpu/GpuBoidSim.js'
import { GpuTimer, Readback } from '../gpu/gl.js'
import { MapTextures } from '../gpu/MapTextures.js'
import { ScumField } from '../gpu/ScumField.js'
import { SiltField } from '../gpu/SiltField.js'
import { SwayField } from '../gpu/SwayField.js'
import { InfluenceField } from '../sim/InfluenceField.js'
import { Dragonflies } from '../sim/Dragonflies.js'
import { Insects } from '../sim/Insects.js'
import { PLANT_KINDS, plantAmountKey } from '../sim/Vegetation.js'
import { LilyPads } from '../sim/LilyPads.js'
import { PondMap } from '../sim/PondMap.js'
import { BoidRenderer } from '../render/BoidRenderer.js'

/** The map extends this far beyond each screen edge, so its shore sits off-screen. */
const WORLD_MARGIN = 48
/** Sim seconds between population samples for the graph, and how many are kept (20 min). */
const HISTORY_TICK = 2
const HISTORY_LENGTH = 600

/**
 * Owns the WebGL context, the GPU simulation, the influence field and the
 * renderer, and runs the rAF loop outside React. React pushes params in and
 * receives throttled stats out.
 *
 * Boid data never leaves the GPU except for explicit, asynchronous reads
 * (picking a boid and inspecting the selected one).
 */
export class Engine {
  constructor(canvas, params, onStats) {
    this.canvas = canvas
    this.params = { ...params }
    this.onStats = onStats
    this.field = new InfluenceField(8)
    this.map = new PondMap(this.field)
    this.map.sparseness = this.params.plantDeepSparseness
    this.map.shallowDensity = this.params.plantShallowDensity
    this.map.logCount = this.params.logCount
    this.map.landClearing = this.params.logLandClearing
    this.map.kindAmounts = PLANT_KINDS.map((k) => this.params[plantAmountKey(k.name)] ?? 1)
    this.pads = new LilyPads(this.map)
    this.insects = new Insects(this.map, this.pads)
    // Their predators: a species of their own that hunts them.
    this.dragonflies = new Dragonflies(this.insects)
    this.time = 0
    this.history = [] // [time, fish, midges, dragonflies]
    this.historyClock = 0
    this.selected = -1
    this.selectedInfo = null
    this.raf = 0
    this.last = 0
    this.frames = 0
    this.statsTime = 0
    this.frameMs = null
    this.measureNext = false
    this.reports = 0
    this.probe = new Uint8Array(4)

    const gl = canvas.getContext('webgl2', {
      antialias: false, // the scene is pixelated on purpose
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 is not supported in this browser.')
    // React StrictMode remounts reuse this canvas; a context lost by an
    // earlier failure would make every shader compile return a null log.
    if (gl.isContextLost()) throw new Error('WebGL context is lost. Reload the page.')
    this.gl = gl

    this.onContextLost = (e) => {
      e.preventDefault()
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.onContextRestored = () => {
      this.initGL()
      this.start()
    }
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.initGL()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
  }

  initGL() {
    const gl = this.gl
    this.sim = new GpuBoidSim(gl, this.params, this.field, this.map)
    this.mapTex = new MapTextures(gl, this.map)
    this.sway = new SwayField(gl)
    this.silt = new SiltField(gl)
    this.scum = new ScumField(gl)
    this.renderer = new BoidRenderer(gl)
    this.insectScumVersion = -1 // scum spots for the midges come from the renderer
    this.readback = new Readback(gl)
    this.simTimer = new GpuTimer(gl)
    this.renderTimer = new GpuTimer(gl)
    this.resize()
    this.sim.setCount(this.params.count)
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    // World = screen plus a margin on every side; the view shows the middle.
    const m = WORLD_MARGIN
    this.map.view = [m, m, w, h]
    // Regenerating the map takes tens of ms: do it immediately the first time,
    // otherwise once the window stops resizing. The simulation world changes
    // together with the map, so fish never swim where there is no map yet.
    const relayout = () => {
      this.field.resize(w + 2 * m, h + 2 * m)
      this.map.layout(w + 2 * m, h + 2 * m)
      this.sim.setBounds(w + 2 * m, h + 2 * m)
      this.sway.resize(w + 2 * m, h + 2 * m)
      this.silt.resize(w + 2 * m, h + 2 * m)
      this.scum.resize(this.sway)
    }
    clearTimeout(this.relayoutTimer)
    if (this.map.width) this.relayoutTimer = setTimeout(relayout, 150)
    else relayout()
    this.renderer.resize(w, h, [m, m])
  }

  setParams(next) {
    // Mutate in place: the simulation holds a reference to this object.
    Object.assign(this.params, next)
    const { map } = this
    const amounts = PLANT_KINDS.map((k) => this.params[plantAmountKey(k.name)] ?? 1)
    if (
      this.params.plantDeepSparseness !== map.sparseness ||
      this.params.plantShallowDensity !== map.shallowDensity ||
      this.params.logLandClearing !== map.landClearing ||
      amounts.some((a, k) => a !== map.kindAmounts[k])
    ) {
      map.sparseness = this.params.plantDeepSparseness
      map.shallowDensity = this.params.plantShallowDensity
      map.landClearing = this.params.logLandClearing
      map.kindAmounts = amounts
      clearTimeout(this.regrowTimer)
      this.regrowTimer = setTimeout(() => this.map.regrowPlants(), 150)
    }
    if (this.params.logCount !== this.map.logCount) {
      this.map.logCount = this.params.logCount
      clearTimeout(this.relayTimer)
      this.relayTimer = setTimeout(() => this.map.relayLogs(), 150)
    }
    this.sim.setCount(this.params.count)
    if (this.selected >= this.sim.count) this.selected = -1
  }

  reset() {
    this.sim.reset()
  }

  /** New floor, land and vegetation; boids respawn in open water. */
  newMap() {
    this.map.newMap()
    this.sim.reset()
  }

  /** Start the midges over: a fresh flock of random genomes, or from a profile. */
  restartMidges(profile = null) {
    this.insects.seed(this.params, profile ?? (this.params.midgeLocked ? this.params.midgeProfile : null))
  }

  /** Start the dragonflies over: newcomers with random genomes, or from a profile. */
  restartDragonflies(profile = null) {
    this.dragonflies.restart(this.params, profile)
  }

  /** Every living dragonfly takes the profile's genome. */
  applyDragonflyProfile(profile) {
    this.dragonflies.applyProfile(profile)
  }

  /** The living dragonflies' mean genome ({ count, generation, genes, spread }), or null. */
  dragonflyPopulation() {
    return this.dragonflies.population()
  }

  /** Every living midge takes the profile's genome. */
  applyMidgeProfile(profile) {
    this.insects.applyProfile(profile)
  }

  /** The living midges' mean genome and where it comes from ({ count, generation, genes, spread }), or null. */
  midgePopulation() {
    return this.insects.population()
  }

  /** Lay the trunks somewhere else (same map). */
  shuffleLogs() {
    this.map.shuffleLogs()
  }

  /**
   * Select what is nearest to a point in canvas CSS pixels: a dragonfly close
   * by, else a midge (they are tiny, so they win over fish), else a boid
   * (async GPU read). Selecting one deselects the others.
   */
  pick(x, y, callback, maxDist = 24) {
    const sim = this.sim
    const n = sim.count
    x += WORLD_MARGIN
    y += WORLD_MARGIN
    const insectsShown = this.params.showInsects
    const dragonfly = insectsShown && this.params.showDragonflies && this.dragonflies.select(x, y)
    const midge = !dragonfly && insectsShown && this.insects.select(x, y)
    if (dragonfly) this.insects.select(-1e9, -1e9)
    if (dragonfly || midge) {
      this.selected = -1
      this.selectedInfo = null
      callback?.(-1)
      return
    }
    if (!n) return
    this.readback.read(sim.currentFbo, this.gl.COLOR_ATTACHMENT0, 0, 0, sim.texW, Math.ceil(n / sim.texW), (data) => {
      let best = -1
      let bestD2 = maxDist * maxDist
      for (let i = 0; i < n; i++) {
        const dx = data[i * 4] - x
        const dy = data[i * 4 + 1] - y
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) {
          bestD2 = d2
          best = i
        }
      }
      this.selected = best
      this.selectedInfo = null
      if (best >= 0) {
        // Deselect the midge and dragonfly.
        this.insects.select(-1e9, -1e9)
        this.dragonflies.select(-1e9, -1e9)
      }
      callback?.(best)
    })
  }

  start() {
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop)
      const dt = this.last ? Math.min((t - this.last) / 1000, 1 / 30) : 1 / 60
      this.last = t
      // Without GPU timer queries, time one whole frame synchronously now and
      // then (CPU submit + GPU execution), so the cost is visible although the
      // display caps the frame rate. It stalls the pipeline, hence rarely.
      const measure = this.measureNext
      this.measureNext = false
      let t0 = 0
      if (measure) {
        this.finish()
        t0 = performance.now()
      }
      this.mapTex.sync()
      this.pads.sync()
      if (this.renderer.scumVersion !== this.insectScumVersion) {
        this.insects.setScum(this.renderer.scumSpots)
        this.insectScumVersion = this.renderer.scumVersion
      }
      // Sim speed: the whole world (fish, water, scum, midges, clouds) steps
      // several times per drawn frame, each a normal-sized step.
      const steps = this.params.paused ? 0 : Math.max(1, Math.round(this.params.simSpeed))
      if (steps) this.simTimer.begin()
      for (let k = 0; k < steps; k++) {
        this.time += dt
        this.sim.step(dt, this.mapTex)
        this.sway.update(this.sim, dt, this.params)
        this.scum.update(this.sway, this.mapTex, dt, this.params)
        this.silt.update(this.sim, this.sway, this.mapTex, dt, this.params)
        if (this.params.showInsects) {
          const hunted = this.params.showDragonflies
          this.insects.predators = hunted ? this.dragonflies : null
          this.insects.update(dt, this.params)
          if (hunted) this.dragonflies.update(dt, this.params)
        }
        this.sampleHistory(dt)
      }
      if (steps) this.simTimer.end()
      if (steps && this.params.showInsects) {
        // Where the shade is, for the midges: a fresh light map every half
        // sim-second (at most once a frame).
        this.shadeClock = (this.shadeClock ?? 0) - dt * steps
        if (this.shadeClock <= 0) {
          this.renderer.shadeWanted = true
          this.shadeClock = 0.5
        }
      }
      this.renderTimer.begin()
      this.renderer.render(
        this.sim,
        this.field,
        this.mapTex,
        this.map.vegetation,
        this.sway,
        this.scum,
        this.silt,
        this.pads,
        this.insects,
        this.dragonflies,
        this.params,
        this.selected,
        this.time,
      )
      this.renderTimer.end()
      if (measure) {
        this.finish()
        const ms = performance.now() - t0
        this.frameMs = this.frameMs == null ? ms : this.frameMs * 0.7 + ms * 0.3
      }
      if (this.renderer.shadeReady) this.readShade()
      this.readback.poll()
      this.simTimer.poll()
      this.renderTimer.poll()
      this.reportStats(t)
    }
    this.raf = requestAnimationFrame(loop)
  }

  /** Read the light map the renderer just drew, asynchronously, into the midges' sim. */
  readShade() {
    const r = this.renderer
    r.shadeReady = false
    const [w, h] = r.shadeDims
    const cell = r.shadeCell
    const offset = [...r.viewOffset]
    this.readback.read(r.shadeFbo, this.gl.COLOR_ATTACHMENT0, 0, 0, w, h, (values) => this.insects.setShade(values, w, h, cell, offset))
  }

  /** Block until the GPU has finished all submitted work (1-pixel read). */
  finish() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probe)
  }

  readSelected() {
    const i = this.selected
    if (i < 0 || i >= this.sim.count) {
      this.selectedInfo = null
      return
    }
    const { gl, sim } = this
    const x = i & (sim.texW - 1)
    const y = i >> sim.texShift
    const info = { index: i }
    this.readback.read(sim.traitsFbo, gl.COLOR_ATTACHMENT0, x, y, 1, 1, (tr) => {
      info.color = BOID_COLORS[tr[0]]
    })
    this.readback.read(sim.currentFbo, gl.COLOR_ATTACHMENT0, x, y, 1, 1, (s) => {
      info.speed = Math.hypot(s[2], s[3])
    })
    this.readback.read(sim.currentFbo, gl.COLOR_ATTACHMENT1, x, y, 1, 1, (a) => {
      info.steering = Math.hypot(a[0], a[1])
      info.neighbors = Math.floor(a[2]) // the fraction carries the swim depth
      if (this.selected === i) this.selectedInfo = info
    })
  }

  /** Every HISTORY_TICK sim seconds, how many of each kind there are (null: not in the sim), for the population graph. */
  sampleHistory(dt) {
    this.historyClock -= dt
    if (this.historyClock > 0) return
    this.historyClock = HISTORY_TICK
    const midges = this.params.showInsects
    const dragonflies = midges && this.params.showDragonflies
    this.history.push([this.time, this.sim.count, midges ? this.insects.alive : null, dragonflies ? this.dragonflies.alive : null])
    if (this.history.length > HISTORY_LENGTH) this.history.shift()
  }

  reportStats(t) {
    this.frames++
    if (!this.statsTime) this.statsTime = t
    const elapsed = t - this.statsTime
    if (elapsed < 250) return
    const fps = (this.frames * 1000) / elapsed
    this.frames = 0
    this.statsTime = t
    const timed = this.renderTimer.ms != null
    if (!timed) this.measureNext = ++this.reports % 8 === 0
    this.readSelected()
    const gpuSimMs = this.params.paused ? 0 : this.simTimer.ms
    this.onStats?.({
      fps,
      gpuSimMs,
      gpuRenderMs: this.renderTimer.ms,
      frameMs: timed ? (gpuSimMs ?? 0) + this.renderTimer.ms : this.frameMs,
      count: this.sim.count,
      midges: this.params.showInsects ? this.insects.stats() : null,
      dragonflies: this.params.showInsects && this.params.showDragonflies ? this.dragonflies.stats() : null,
      selected: this.selected >= 0 ? this.selectedInfo : null,
      history: this.history.slice(),
    })
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.relayoutTimer)
    clearTimeout(this.regrowTimer)
    clearTimeout(this.relayTimer)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    // Free GPU resources but keep the context alive: React StrictMode
    // remounts onto the same canvas and would get a dead context back.
    this.readback.destroy()
    this.simTimer.destroy()
    this.renderTimer.destroy()
    this.sim.destroy()
    this.mapTex.destroy()
    this.sway.destroy()
    this.silt.destroy()
    this.scum.destroy()
    this.renderer.destroy()
  }
}
