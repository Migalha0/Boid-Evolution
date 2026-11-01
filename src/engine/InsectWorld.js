import { DRAGONFLY, FLYING, INSECT_STRIDE, ON_FLOWER, ON_WATER } from '../sim/Insects.js'
import { PLANT_STRIDE } from '../sim/Vegetation.js'

/** Most steps owed to the worker before the excess is dropped (it fell far behind: the insects slow down, the fish don't). */
const MAX_OWED = 600
/** Messages the worker may have in hand at once; past that, steps wait (owed) and go with the next one. */
const MAX_IN_FLIGHT = 3
/** Frames held for playback; past that the oldest are dropped, so the insects never lag far behind. */
const MAX_QUEUED = 3
/**
 * Trails: shown frames they reach back over, their opacity at the head, and
 * the fastest an insect flies (px/s): a longer hop than that over the sim
 * time between two frames is a slot reused by a newcomer, not a flight.
 */
const TRAIL_FRAMES = 3
const TRAIL_ALPHA = 0.55
const TRAIL_MAX_SPEED = 200
/** Trail colour of a midge (a pale brown, so it reads over dark water). */
const MIDGE_TRAIL = [0.36, 0.3, 0.22]
/** Seconds between stats requests (the panels refresh 4 times a second). */
const STATS_EVERY = 0.25

/**
 * The main thread's side of the insect worker (sim/simWorker.js): the
 * midges and dragonflies run there, so they cost the fish no frame time.
 *
 * Each frame the engine says how many steps to take; they go to the worker
 * at once, one message per frame (without waiting for its answers, up to
 * MAX_IN_FLIGHT), and each comes back as a frame of both point buffers,
 * nectar and stats. Answers arrive at their own pace, so they are queued and
 * shown one per drawn frame (present()): every frame moves the insects by
 * exactly that frame's steps, a frame or two late, instead of jumping by two
 * now and then. `midges` and `dragonflies` are what the renderer draws (data,
 * points, version); `stats` and `alive` are the latest shown.
 */
export class InsectWorld {
  constructor(map, pads) {
    this.map = map
    this.pads = pads
    this.worker = new Worker(new URL('../sim/simWorker.js', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e) => this.receive(e.data)
    this.midges = { data: new Float32Array(0), points: 0, version: 0 }
    this.dragonflies = { data: new Float32Array(0), points: 0, version: 0 }
    // Motion trails through the last few shown frames (drawn under the bodies).
    this.past = []
    this.midges.trails = { data: new Float32Array(0), count: 0, version: 0 }
    this.trailsOn = true
    this.alive = [0, 0]
    this.stats = { midges: null, dragonflies: null }
    this.pending = 0 // messages the worker has yet to answer with a frame
    this.queue = [] // its answers, waiting to be shown
    this.owedSteps = 0
    this.owedTime = 0
    this.statsClock = 0
    this.worldKey = ''
    // Keeping up: sim seconds asked for and done, sampled about once a second.
    this.asked = 0
    this.done = 0
    this.paceMark = null
    this.pace = 1
  }

  post(message, transfer) {
    this.worker.postMessage(message, transfer)
  }

  setParams(params) {
    this.trailsOn = Boolean(params.insectTrails)
    this.post({ type: 'params', params: { ...params } })
  }

  /** Send the world again if the map, plants or pads changed since. */
  syncWorld() {
    const { map, pads } = this
    const veg = map.vegetation
    const key = `${map.width}x${map.height}|${map.version}|${map.logVersion}|${veg.version}|${pads.version}`
    if (key === this.worldKey || !map.width) return
    this.worldKey = key
    const world = {
      width: map.width,
      height: map.height,
      sdf: map.sdf.slice(),
      sdfCols: map.sdfCols,
      sdfRows: map.sdfRows,
      logs: map.logs.map((l) => ({ ...l })),
      plants: veg.data.slice(0, veg.count * PLANT_STRIDE),
      bloom: veg.bloom.slice(0, Math.max(veg.count, 1)),
      plantCount: veg.count,
      plantVersion: veg.version,
      pads: pads.data.slice(),
      padCount: pads.count,
      padVersion: pads.version,
    }
    this.post({ type: 'world', world }, [world.sdf.buffer, world.plants.buffer, world.bloom.buffer, world.pads.buffer])
  }

  setScum(points) {
    this.post({ type: 'scum', points })
  }

  setShade(values, w, h, cell, offset) {
    this.post({ type: 'shade', values, w, h, cell, offset }, [values.buffer])
  }

  /** `steps` steps of `dt` s are due. */
  step(steps, dt) {
    this.asked += steps * dt
    this.owedSteps += steps
    this.owedTime += steps * dt
    this.statsClock -= steps * dt
    if (this.owedSteps > MAX_OWED) {
      this.owedTime *= MAX_OWED / this.owedSteps
      this.owedSteps = MAX_OWED
    }
    this.flush()
  }

  flush() {
    if (this.pending >= MAX_IN_FLIGHT || !this.owedSteps) return
    const stats = this.statsClock <= 0
    if (stats) this.statsClock = STATS_EVERY
    this.post({ type: 'step', steps: this.owedSteps, dt: this.owedTime / this.owedSteps, stats })
    this.pending++
    this.owedSteps = 0
    this.owedTime = 0
  }

  /** Commands that answer with a frame (in order with the steps). */
  command(message) {
    this.post(message)
    this.pending++
  }

  receive(m) {
    this.pending--
    this.queue.push(m)
    this.flush()
  }

  /** Show the next frame the worker sent, if any (once per drawn frame, before drawing). */
  present() {
    while (this.queue.length > MAX_QUEUED) this.show(this.queue.shift())
    const m = this.queue.shift()
    if (m) this.show(m)
  }

  show(m) {
    this.midges.data = m.midges.data
    this.midges.points = m.midges.points
    this.midges.version++
    this.dragonflies.data = m.dragonflies.data
    this.dragonflies.points = m.dragonflies.points
    this.dragonflies.version++
    this.alive = m.alive
    this.done = m.time
    this.past.unshift({ midges: m.midges, dragonflies: m.dragonflies, time: m.time })
    if (this.past.length > TRAIL_FRAMES + 1) this.past.pop()
    this.buildTrails()
    // Nectar, if it is still about the plants we have (not a regrown set).
    const veg = this.map.vegetation
    if (m.bloom && m.plantVersion === veg.version && m.bloom.length <= veg.bloom.length) {
      veg.bloom.set(m.bloom)
      veg.bloomVersion++
    }
    if (m.stats) this.stats = m.stats
  }

  /**
   * Lines from each flying insect back through where it was in the last
   * TRAIL_FRAMES shown frames, fading out: at high sim speeds an insect hops
   * many px per frame, and the trail makes that read as flight.
   */
  buildTrails() {
    const trails = this.midges.trails
    trails.count = 0
    if (!this.trailsOn || this.past.length < 2) return
    const S = INSECT_STRIDE
    let max = 0
    for (let a = 0; a + 1 < this.past.length; a++) max += Math.min(this.past[a].midges.points, this.past[a + 1].midges.points) + Math.min(this.past[a].dragonflies.points, this.past[a + 1].dragonflies.points)
    if (trails.data.length < max * 12) trails.data = new Float32Array(max * 12 * 1.5)
    const out = trails.data
    let n = 0
    const add = (x0, y0, x1, y1, r, g, b, a0, a1) => {
      const o = n * 6
      out[o] = x0
      out[o + 1] = y0
      out[o + 2] = r * a0
      out[o + 3] = g * a0
      out[o + 4] = b * a0
      out[o + 5] = a0
      out[o + 6] = x1
      out[o + 7] = y1
      out[o + 8] = r * a1
      out[o + 9] = g * a1
      out[o + 10] = b * a1
      out[o + 11] = a1
      n += 2
    }
    for (let a = 0; a + 1 < this.past.length; a++) {
      // Segment `a`: from frame a + 1 (older) to frame a (newer); 0 is the newest.
      const head = TRAIL_ALPHA * (1 - a / TRAIL_FRAMES)
      const tail = TRAIL_ALPHA * (1 - (a + 1) / TRAIL_FRAMES)
      const maxHop = (this.past[a].time - this.past[a + 1].time) * TRAIL_MAX_SPEED + 4
      for (const [kind, flying] of [
        ['midges', FLYING],
        ['dragonflies', DRAGONFLY],
      ]) {
        const now = this.past[a][kind]
        const then = this.past[a + 1][kind]
        const pts = Math.min(now.points, then.points)
        const d1 = now.data
        const d0 = then.data
        for (let i = 0; i < pts; i++) {
          const o = i * S
          if (d1[o + 3] !== flying || d0[o + 3] !== flying) continue
          const dx = d1[o] - d0[o]
          const dy = d1[o + 1] - d0[o + 1]
          const hop = dx * dx + dy * dy
          if (hop < 1 || hop > maxHop * maxHop) continue
          if (flying === FLYING) add(d0[o], d0[o + 1], d1[o], d1[o + 1], MIDGE_TRAIL[0], MIDGE_TRAIL[1], MIDGE_TRAIL[2], tail, head)
          else {
            // A dragonfly's trail in its own colour (packed r, g, b in data[6]).
            const c = d1[o + 6]
            const r = Math.floor(c / 65536)
            const g = Math.floor((c - r * 65536) / 256)
            add(d0[o], d0[o + 1], d1[o], d1[o + 1], r / 255, g / 255, (c - r * 65536 - g * 256) / 255, tail, head)
          }
        }
      }
    }
    trails.count = n
    trails.version++
  }

  /**
   * The share of the asked-for sim time the worker managed over about the
   * last second (1: keeping up; 0.5: the insects run at half the sim speed).
   */
  measurePace(now) {
    const mark = this.paceMark
    if (!mark) {
      this.paceMark = { now, asked: this.asked, done: this.done }
      return this.pace
    }
    if (now - mark.now < 1000) return this.pace
    const asked = this.asked - mark.asked
    if (asked > 0) this.pace = Math.min(1, (this.done - mark.done) / asked)
    this.paceMark = { now, asked: this.asked, done: this.done }
    return this.pace
  }

  /**
   * Whether a dragonfly (else a midge) is within reach of (x, y) in world px,
   * from the latest buffers; if so the worker selects it. Returns 'dragonfly',
   * 'midge' or null.
   */
  pick(x, y, dragonflies) {
    const near = (source, maxDist, hit) => {
      const d = source.data
      for (let i = 0; i < source.points; i++) {
        const o = i * INSECT_STRIDE
        if (hit(d[o + 3]) && (d[o] - x) ** 2 + (d[o + 1] - y) ** 2 < maxDist * maxDist) return true
      }
      return false
    }
    const kind = dragonflies && near(this.dragonflies, 14, (s) => s === DRAGONFLY) ? 'dragonfly' : near(this.midges, 10, (s) => s === FLYING || s === ON_WATER || s === ON_FLOWER) ? 'midge' : null
    if (kind) this.command({ type: 'select', kind, x, y })
    return kind
  }

  deselect() {
    this.command({ type: 'deselect' })
  }

  restartMidges(profile) {
    this.command({ type: 'restartMidges', profile })
  }

  restartDragonflies(profile) {
    this.command({ type: 'restartDragonflies', profile })
  }

  applyMidgeProfile(profile) {
    this.command({ type: 'applyMidges', profile })
  }

  applyDragonflyProfile(profile) {
    this.command({ type: 'applyDragonflies', profile })
  }

  destroy() {
    this.worker.terminate()
  }
}
