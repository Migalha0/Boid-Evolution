import { BoidKernel } from '../gpu/boids/BoidKernel.js'
import { createFramebuffer, createTexture, GpuTimer, Readback } from '../gpu/gl.js'
import { PondGpu, SOURCE } from '../gpu/PondGpu.js'
import { SEEN_STYLES } from '../render/focus.js'
import { mutate } from '../sim/genetics.js'
import { FISH } from '../species/fish.js'
import { DEATH, MIDGE_GENES, MIDGES, MODE } from '../species/midges.js'
import { MapTextures } from '../gpu/MapTextures.js'
import { ScumField } from '../gpu/ScumField.js'
import { SiltField } from '../gpu/SiltField.js'
import { SwayField } from '../gpu/SwayField.js'
import { PLANT_KINDS, plantAmountKey } from '../sim/Vegetation.js'
import { LilyPads } from '../sim/LilyPads.js'
import { PondMap } from '../sim/PondMap.js'
import { BoidRenderer } from '../render/BoidRenderer.js'
import { Wind } from '../sim/Wind.js'
import { Laying } from './Laying.js'
import { Species } from './Species.js'

/** The map extends this far beyond each screen edge, so its shore sits off-screen. */
const WORLD_MARGIN = 48
/** Sim seconds between population samples for the graph, and how many are kept (20 min). */
const HISTORY_TICK = 2
const HISTORY_LENGTH = 600
/** Midges' history in their own panel: samples kept. */
const MIDGE_HISTORY_LENGTH = 300
/** Swarm count: grid cells (px) with at least SWARM_MIN midges in flight. */
const SWARM_CELL = 40
const SWARM_MIN = 4

/**
 * Owns the WebGL context, the GPU species (fish and midges, both on the GPU
 * base boid: gpu/boids/BoidKernel.js), the pond's GPU fields (flowers,
 * nectar, items: PondGpu) and the renderer, and runs the rAF loop outside
 * React. React pushes params in and receives throttled stats out.
 *
 * Boid data never leaves the GPU except for explicit, asynchronous reads
 * (picking, the selected one, and the midges' stats now and then).
 */
export class Engine {
  constructor(canvas, params, onStats) {
    this.canvas = canvas
    this.params = { ...params }
    this.onStats = onStats
    this.map = new PondMap()
    this.map.sparseness = this.params.plantDeepSparseness
    this.map.shallowDensity = this.params.plantShallowDensity
    this.map.logCount = this.params.logCount
    this.map.landClearing = this.params.logLandClearing
    this.map.kindAmounts = PLANT_KINDS.map((k) => this.params[plantAmountKey(k.name)] ?? 1)
    this.map.waterDepth = this.params.waterDepth
    this.map.landAmount = this.params.landAmount
    this.pads = new LilyPads(this.map)
    this.time = 0
    this.wind = new Wind()
    this.history = [] // [time, fish, midges]
    this.historyClock = 0
    // Midges: how many the last flock had, and their stats.
    this.midgeFlock = 0
    this.midgeStats = null
    this.midgeHistory = []
    this.midgeExtinctions = 0
    this.midgesPresent = false
    this.lockedProfile = null
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
    this.readback = new Readback(gl)
    this.sim = new BoidKernel(gl, FISH, this.map)
    this.midgeSim = new BoidKernel(gl, MIDGES, this.map)
    this.fish = new Species(gl, this.readback, this.sim)
    this.midges = new Species(gl, this.readback, this.midgeSim)
    this.laying = new Laying(this.midgeSim, this.readback)
    this.pond = new PondGpu(gl, this.map, this.pads)
    this.midgePrev = null // the midges' state at the frame's start (for trails)
    this.mapTex = new MapTextures(gl, this.map)
    this.sway = new SwayField(gl)
    this.silt = new SiltField(gl)
    this.scum = new ScumField(gl)
    this.renderer = new BoidRenderer(gl)
    this.renderer.liveWind = this.wind
    this.pondScumVersion = -1 // scum spots for the midges come from the renderer
    this.simTimer = new GpuTimer(gl)
    this.renderTimer = new GpuTimer(gl)
    if (this.map.width) this.fitToMap() // a restored context: the map is already laid out
    this.resize()
    this.sim.setCount(this.params.count, this.params)
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    const map = this.map
    // A window that still fits in the world (smaller, or back to a size it
    // had: a fullscreen browser showing its toolbar) keeps the world and
    // shows its middle. Only a bigger one lays the world out again (then
    // the screen plus a margin on every side), once it stops resizing.
    clearTimeout(this.relayoutTimer)
    if (map.width && w + 2 * WORLD_MARGIN <= map.width && h + 2 * WORLD_MARGIN <= map.height) {
      this.setView(w, h)
      return
    }
    if (map.width) this.relayoutTimer = setTimeout(() => this.layoutWorld(w, h), 150)
    else this.layoutWorld(w, h)
  }

  /** The world sized to a w x h screen plus the margins (laid out again if that changes its size; `fresh`: a new map), the view in its middle. */
  layoutWorld(w, h, fresh = false) {
    const W = w + 2 * WORLD_MARGIN
    const H = h + 2 * WORLD_MARGIN
    // The view first: plants, pads and trunks are laid out only inside it.
    this.map.view = [WORLD_MARGIN, WORLD_MARGIN, w, h]
    if (fresh) this.map.newMap(W, H)
    else this.map.layout(W, H)
    this.fitToMap()
    this.setView(w, h)
  }

  /** The simulation world sized as the map, so fish never swim where there is no map yet. */
  fitToMap() {
    const { width, height } = this.map
    this.sim.setBounds(width, height)
    this.midgeSim.setBounds(width, height)
    this.sway.resize(width, height)
    this.silt.resize(width, height)
    this.scum.resize(this.sway)
  }

  /** Show w x h of the world, centred. */
  setView(w, h) {
    const offset = [Math.round((this.map.width - w) / 2), Math.round((this.map.height - h) / 2)]
    this.viewOffset = offset
    this.map.view = [offset[0], offset[1], w, h]
    this.renderer.resize(w, h, offset)
  }

  setParams(next) {
    // Mutate in place: the simulation holds a reference to this object.
    Object.assign(this.params, next)
    this.syncMap()
    this.sim.setCount(this.params.count, this.params)
    if (this.fish.selected >= this.sim.count) this.fish.select(-1)
    // Locked to a profile: every midge carries it exactly (applied once per profile).
    const locked = this.params.midgeLocked ? this.params.midgeProfile : null
    if (locked !== this.lockedProfile) {
      this.lockedProfile = locked
      if (locked) this.applyMidgeProfile(locked)
    }
  }

  /**
   * The map follows its params once they stop changing (each takes tens of
   * ms): a new water depth lays out everything again (with the trunk count
   * and plants as they are by then); else new trunks bring their plants, or
   * the plants alone regrow.
   */
  syncMap() {
    const { map, params: p } = this
    const amounts = PLANT_KINDS.map((k) => p[plantAmountKey(k.name)] ?? 1)
    const plants =
      p.plantDeepSparseness !== map.sparseness ||
      p.plantShallowDensity !== map.shallowDensity ||
      p.logLandClearing !== map.landClearing ||
      amounts.some((a, k) => a !== map.kindAmounts[k])
    const logs = p.logCount !== map.logCount
    const depth = p.waterDepth !== map.waterDepth || p.landAmount !== map.landAmount
    if (!plants && !logs && !depth) return
    map.sparseness = p.plantDeepSparseness
    map.shallowDensity = p.plantShallowDensity
    map.landClearing = p.logLandClearing
    map.kindAmounts = amounts
    map.logCount = p.logCount
    const work = depth ? () => (map.setWaterDepth(p.waterDepth), map.setLandAmount(p.landAmount)) : logs ? () => map.relayLogs() : () => map.regrowPlants()
    // One pending job, the biggest asked for since the last ran.
    const rank = depth ? 3 : logs ? 2 : 1
    if (!this.mapJob || rank >= this.mapJob.rank) this.mapJob = { rank, work }
    clearTimeout(this.mapTimer)
    this.mapTimer = setTimeout(() => {
      this.mapJob.work()
      this.mapJob = null
    }, 150)
  }

  reset() {
    this.sim.reset(this.params)
  }

  /** New floor, land and vegetation; boids respawn in open water. */
  newMap() {
    // Sized to the window as it is now (it may have kept a bigger world).
    const rect = this.canvas.getBoundingClientRect()
    this.layoutWorld(Math.max(1, rect.width), Math.max(1, rect.height), true)
    this.sim.reset(this.params)
  }

  /** Start the midges over: a fresh flock of `insectStart`, random genomes or the profile's (mutated unless locked). */
  restartMidges(profile = null) {
    const p = this.params
    const source = profile ?? (p.midgeLocked ? p.midgeProfile : null)
    const base = source ? MIDGE_GENES.map((g) => source.genes[g.key] ?? (g.min + g.max) / 2) : null
    const genome = base ? (p.midgeLocked ? base : () => mutate(MIDGE_GENES, base, p.mutationRate, p.mutationSize, p.mutationFlip)) : null
    const n = Math.max(0, Math.round(p.insectStart))
    this.pond.sync()
    this.midgeSim.setCount(n, p, genome)
    this.midgeSim.reset(p, genome)
    this.laying.reset()
    this.midges.select(-1)
    this.midgeFlock = n
    this.midgesPresent = n > 0
    this.midgeStats = null
  }

  /** Every midge gone (the user's doing: not counted as dying out). */
  clearMidges() {
    this.midgeSim.setCount(0, this.params)
    this.laying.reset()
    this.midges.select(-1)
    this.midgeFlock = 0
    this.midgesPresent = false
    this.midgeStats = null
  }

  /** Every midge takes the profile's genome. */
  applyMidgeProfile(profile) {
    const genome = MIDGE_GENES.map((g) => profile.genes[g.key] ?? (g.min + g.max) / 2)
    if (this.midgeSim.count) this.midgeSim.writeGenes(() => genome)
  }

  /** The living midges' mean genome ({ count, genes, spread }), or null (as last read back). */
  midgePopulation() {
    return this.midgeStats?.population ?? null
  }

  /** Lay the trunks somewhere else (same map). */
  shuffleLogs() {
    this.map.shuffleLogs()
  }

  /**
   * Select what is nearest to a point in canvas CSS pixels: a midge close by
   * (they are tiny, so they win over fish), else a fish (async GPU reads).
   * Selecting one deselects the other.
   */
  pick(x, y, callback, maxDist = 24) {
    x += this.viewOffset[0]
    y += this.viewOffset[1]
    // Only the latest pick counts (reads finish late; Escape cancels one in flight).
    const token = (this.pickToken = (this.pickToken ?? 0) + 1)
    const fish = () =>
      this.fish.pick(x, y, maxDist, (i) => {
        if (token !== this.pickToken) return
        this.fish.select(i)
        if (i >= 0) this.midges.select(-1)
        callback?.(i)
      })
    if (!this.params.showInsects || !this.midgeSim.count) return fish()
    this.midges.pick(x, y, 10, (i) => {
      if (token !== this.pickToken) return
      if (i < 0) return fish()
      this.midges.select(i)
      this.fish.select(-1)
      callback?.(-1)
    })
  }

  /** Nothing selected: no fish or midge (and any pick still in flight dropped). */
  deselect() {
    this.pickToken = (this.pickToken ?? 0) + 1
    this.fish.select(-1)
    this.midges.select(-1)
  }

  /** The midges' state at the frame's start, kept for their trails (a copy, sized to their textures). */
  keepMidgeTrail() {
    const gl = this.gl
    const k = this.midgeSim
    if (!k.particle) return
    const { w, h } = k.particle
    if (!this.midgePrev || this.midgePrev.w !== w || this.midgePrev.h !== h) {
      if (this.midgePrev) {
        gl.deleteTexture(this.midgePrev.tex)
        gl.deleteFramebuffer(this.midgePrev.fbo)
      }
      const tex = createTexture(gl, gl.RGBA32F, w, h)
      this.midgePrev = { tex, fbo: createFramebuffer(gl, [tex]), w, h }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, k.currentFbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.midgePrev.fbo)
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
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
      this.pads.amount = this.params.padAmount
      this.pads.sync()
      this.pond.colourVariation = this.params.flowerVariation
      if (this.renderer.scumVersion !== this.pondScumVersion) {
        this.pond.setScum(this.renderer.scumSpots)
        this.pondScumVersion = this.renderer.scumVersion
      }
      this.pond.sync()
      // Sim speed: the whole world (fish, water, scum, midges, clouds) steps
      // several times per drawn frame, each a normal-sized step.
      const steps = this.params.paused ? 0 : Math.max(1, Math.round(this.params.simSpeed))
      const midges = this.params.showInsects && this.midgeSim.count > 0
      if (steps) this.simTimer.begin()
      this.sim.debugId = this.fish.selected
      this.midgeSim.debugId = this.midges.selected
      if (steps && midges) this.keepMidgeTrail()
      for (let k = 0; k < steps; k++) {
        this.time += dt
        this.wind.update(dt, this.params)
        const ctx = { params: this.params, mapTex: this.mapTex, pond: this.pond, laying: this.laying, wind: this.wind, time: this.time }
        this.sim.step(dt, ctx)
        if (midges) {
          this.pond.updateFlowers(dt, this.params, this.time)
          this.midgeSim.step(dt, ctx)
          this.pond.drink(this.midgeSim, dt)
        }
        this.sway.update(this.sim, dt, this.params)
        this.scum.update(this.sway, this.mapTex, dt, this.params)
        this.silt.update(this.sim, this.sway, this.mapTex, dt, this.params)
        this.sampleHistory(dt)
      }
      if (steps) this.simTimer.end()
      if (steps && midges) this.laying.poll(this.params)
      this.fish.readFocus(steps > 0)
      this.midges.readFocus(steps > 0)
      this.renderer.nectarTex = this.pond.nectarTexture
      this.renderer.flowerLookTex = this.pond.flowerLook
      this.renderTimer.begin()
      this.renderer.render(
        this.sim,
        this.mapTex,
        this.map.vegetation,
        this.sway,
        this.scum,
        this.silt,
        this.pads,
        { kernel: this.midgeSim, prev: this.midgePrev?.tex ?? null, selected: this.midges.selected, pond: this.pond, frameTime: dt * Math.max(steps, 1), seenStyles: this.seenStyles() },
        this.params,
        this.fish.selected,
        this.time,
        [this.midges.focus, this.fish.focus],
      )
      this.renderTimer.end()
      if (measure) {
        this.finish()
        const ms = performance.now() - t0
        this.frameMs = this.frameMs == null ? ms : this.frameMs * 0.7 + ms * 0.3
      }
      this.readback.poll()
      this.simTimer.poll()
      this.renderTimer.poll()
      this.reportStats(t)
    }
    this.raf = requestAnimationFrame(loop)
  }

  /** How the selected midge's seen items are ringed, per item source (render/focus.js SEEN_STYLES). */
  seenStyles() {
    if (this.seenStyleCache) return this.seenStyleCache
    const colours = new Float32Array(16)
    const radii = new Float32Array(4)
    for (const [key, src] of Object.entries(SOURCE)) {
      const st = SEEN_STYLES[key]
      colours.set([...st.colour, st.alpha], src * 4)
      radii[src] = st.ring
    }
    this.seenStyleCache = { colours, radii }
    return this.seenStyleCache
  }

  /** Block until the GPU has finished all submitted work (1-pixel read). */
  finish() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probe)
  }

  /**
   * The midges read back (about once a second): alive, eating, swarms, eggs
   * and births and deaths (engine/Laying.js counts them), flowers drunk dry
   * and resting, dying out, history and the population summary.
   */
  readMidgeStats() {
    const k = this.midgeSim
    if (!this.params.showInsects) return
    this.midges.readAll(({ alive, population, state, aux }) => {
      let eating = 0
      const cells = new Map()
      for (let i = 0; i < k.count; i++) {
        const mode = aux[i * 4 + 1]
        if (mode === MODE.onFlower) eating++
        if (mode !== MODE.flying) continue
        const c = Math.floor(state[i * 4] / SWARM_CELL) * 4096 + Math.floor(state[i * 4 + 1] / SWARM_CELL)
        cells.set(c, (cells.get(c) ?? 0) + 1)
      }
      let swarms = 0
      for (const v of cells.values()) if (v >= SWARM_MIN) swarms++
      const L = this.laying
      const left = alive + L.eggs
      if (!left && this.midgesPresent) this.midgeExtinctions++
      this.midgesPresent = left > 0
      this.midgeHistory.push([this.time, alive])
      if (this.midgeHistory.length > MIDGE_HISTORY_LENGTH) this.midgeHistory.shift()
      this.midgeStats = {
        alive,
        eating,
        swarms,
        eggs: L.eggs,
        laid: L.laid,
        hatched: L.hatched,
        deaths: { starved: L.deaths[DEATH.starved] ?? 0, old: L.deaths[DEATH.old] ?? 0 },
        ...(this.flowerStats ?? { dry: 0, resting: 0, flowers: 0 }),
        time: this.time,
        extinctions: this.midgeExtinctions,
        extinct: this.midgeFlock > 0 && !left,
        history: this.midgeHistory.slice(),
        population,
      }
    })
    const N = this.pond.nectar
    if (N) {
      this.readback.read(N.fbo[this.pond.cur], this.gl.COLOR_ATTACHMENT0, 0, 0, 2048, N.rows, (d) => {
        let dry = 0
        let resting = 0
        let flowers = 0
        for (let o = 0; o < d.length; o += 4) {
          if (d[o + 3] < -1.5) continue
          flowers++
          if (d[o + 1] > 1) resting++
          else if (d[o + 1] === 1) dry++
        }
        this.flowerStats = { dry, resting, flowers }
      })
    }
  }

  /** Every HISTORY_TICK sim seconds, how many of each kind there are (null: not in the sim), for the population graph. */
  sampleHistory(dt) {
    this.historyClock -= dt
    if (this.historyClock > 0) return
    this.historyClock = HISTORY_TICK
    const midges = this.params.showInsects && this.midgeSim.count > 0
    this.history.push([this.time, this.sim.count, midges ? (this.midgeStats?.alive ?? this.midgeFlock) : null])
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
    this.fish.readSelected()
    this.midges.readSelected()
    this.statsTicks = (this.statsTicks ?? 0) + 1
    if (this.statsTicks % 4 === 0) this.readMidgeStats() // about once a second
    const gpuSimMs = this.params.paused ? 0 : this.simTimer.ms
    const midgeStats = this.params.showInsects ? (this.midgeStats ?? { alive: this.midgeSim.count, eating: 0, swarms: 0, eggs: 0, laid: 0, hatched: 0, deaths: { starved: 0, old: 0 }, dry: 0, resting: 0, flowers: 0, time: this.time, extinctions: this.midgeExtinctions, extinct: false, history: this.midgeHistory.slice(), population: null }) : null
    this.onStats?.({
      fps,
      gpuSimMs,
      gpuRenderMs: this.renderTimer.ms,
      frameMs: timed ? (gpuSimMs ?? 0) + this.renderTimer.ms : this.frameMs,
      count: this.sim.count,
      wind: { direction: this.wind.direction ?? this.params.windDirection, speed: this.wind.speed },
      midges: midgeStats && { ...midgeStats, selected: this.midges.selected >= 0 ? this.midges.selectedInfo : null },
      selected: this.fish.selected >= 0 ? this.fish.selectedInfo : null,
      history: this.history.slice(),
    })
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.relayoutTimer)
    clearTimeout(this.mapTimer)
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
    this.midgeSim.destroy()
    this.pond.destroy()
    if (this.midgePrev) {
      this.gl.deleteTexture(this.midgePrev.tex)
      this.gl.deleteFramebuffer(this.midgePrev.fbo)
    }
  }
}
