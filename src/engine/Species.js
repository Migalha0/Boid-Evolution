import { summarize } from '../sim/genetics.js'
import { Lines } from '../render/focus.js'

/**
 * The main thread's side of one GPU species (a BoidKernel): what the panels
 * and overlays need from it, all through small asynchronous readbacks.
 *
 * - pick(): the nearest living one to a point.
 * - The selected one: its focus (each force as an arrow, from the debug
 *   pass), and its description (the definition's describe()).
 * - stats(): everyone read back now and then: alive, a population summary
 *   of the genes, whatever the definition's summarize() adds.
 */
export class Species {
  constructor(gl, readback, kernel) {
    this.gl = gl
    this.readback = readback
    this.kernel = kernel
    this.selected = -1
    this.selectedInfo = null
    this.senses = null
    this.focus = new Lines()
    this.stats = null
  }

  get def() {
    return this.kernel.def
  }

  /** Whether a boid with aux `a` (4 floats) is alive. */
  alive(a, o = 0) {
    return this.def.alive ? this.def.alive(a, o) : true
  }

  /** The nearest living one within maxDist of (x, y) world px: callback(index or -1). */
  pick(x, y, maxDist, callback) {
    const k = this.kernel
    const n = k.count
    if (!n) return callback(-1)
    const rows = Math.ceil(n / k.texW)
    this.readback.read(k.currentFbo, this.gl.COLOR_ATTACHMENT1, 0, 0, k.texW, rows, (aux) => {
      this.readback.read(k.currentFbo, this.gl.COLOR_ATTACHMENT0, 0, 0, k.texW, rows, (state) => {
        let best = -1
        let bestD2 = maxDist * maxDist
        for (let i = 0; i < n; i++) {
          if (!this.alive(aux, i * 4)) continue
          const d2 = (state[i * 4] - x) ** 2 + (state[i * 4 + 1] - y) ** 2
          if (d2 < bestD2) {
            bestD2 = d2
            best = i
          }
        }
        callback(best)
      })
    })
  }

  /** Select boid i (-1: none). Switching to another keeps the last one's info showing until the new one's is read, so a panel never blinks. */
  select(i) {
    this.selected = i
    this.focus.clear()
    if (i >= 0) return
    this.selectedInfo = null
    this.senses = null
  }

  /** The selected one's forces from the debug pass, after a frame that stepped. */
  readFocus(stepped) {
    const k = this.kernel
    const i = this.selected
    k.debugId = i
    if (i < 0 || i >= k.count) {
      if (this.focus.count) this.focus.clear()
      this.senses = null
      return
    }
    if (!stepped) return // paused: the last forces stay
    this.readback.read(k.debugFbo, this.gl.COLOR_ATTACHMENT0, 0, 0, k.layout.width, 1, (d) => {
      if (this.selected !== i) return
      const { forces, seen, signals, pos } = k.decodeDebug(d)
      this.focus.clear()
      this.focus.forces(pos[0], pos[1], forces)
      this.focus.version++
      this.senses = { seen, signals, forces: Object.fromEntries(Object.entries(forces).map(([key, [x, y]]) => [key, Math.hypot(x, y)])) }
    })
  }

  /** The selected one's state, aux, traits, genome and vert (one texel each), described by the definition. */
  readSelected() {
    const k = this.kernel
    const i = this.selected
    if (i < 0 || i >= k.count) {
      this.selectedInfo = null
      return
    }
    const { gl } = this
    const x = i & (k.texW - 1)
    const y = i >> k.texShift
    const got = {}
    const done = () => {
      if (this.selected !== i || !got.state || !got.aux || !got.traits || !got.genes || (k.vertical && !got.vert)) return
      const genome = this.def.genes.map((_, g) => got.genes[g])
      this.selectedInfo = { index: i, id: i, generation: 0, senses: this.senses, ...this.def.describe(got.state, got.aux, got.traits, genome, k.time, k.params, got.vert) }
    }
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT0, x, y, 1, 1, (v) => ((got.state = v), done()))
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT1, x, y, 1, 1, (v) => ((got.aux = v), done()))
    this.readback.read(k.traitsFbo, gl.COLOR_ATTACHMENT0, x, y, 1, 1, (v) => ((got.traits = v), done()))
    if (k.vertical) this.readback.read(k.currentFbo, k.vertAttachment, x, y, 1, 1, (v) => ((got.vert = v), done()))
    const T = k.geneTexels
    this.readback.read(k.genesFbo, gl.COLOR_ATTACHMENT0, x * T, y, T, 1, (v) => ((got.genes = v), done()))
  }

  /**
   * Everyone read back (state, aux, genes): callback({ alive, population,
   * state, aux }) with the population summary of the living ({ count,
   * genes, spread }, or null).
   */
  readAll(callback) {
    const k = this.kernel
    const n = k.count
    if (!n) return callback({ alive: 0, population: null, state: new Float32Array(0), aux: new Float32Array(0) })
    const { gl } = this
    const rows = Math.ceil(n / k.texW)
    const got = {}
    const T = k.geneTexels
    const done = () => {
      if (!got.state || !got.aux || !got.genes) return
      const NG = this.def.genes.length
      const pool = new Float32Array(n * NG)
      const slots = []
      let genSum = 0
      let genMax = 0
      for (let i = 0; i < n; i++) {
        if (!this.alive(got.aux, i * 4)) continue
        slots.push(i)
        const gen = this.def.lays ? Math.floor(got.aux[i * 4 + 3]) : 0 // a laying species keeps its generation in aux.w (its whole part: midges keep latch bits in the fraction)
        genSum += gen
        genMax = Math.max(genMax, gen)
        for (let g = 0; g < NG; g++) pool[i * NG + g] = got.genes[i * T * 4 + g]
      }
      const population = NG && slots.length ? { count: slots.length, generation: genSum / slots.length, maxGeneration: genMax, ...summarize(this.def.genes, pool, slots) } : null
      callback({ alive: slots.length, population, state: got.state, aux: got.aux })
    }
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT0, 0, 0, k.texW, rows, (v) => ((got.state = v), done()))
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT1, 0, 0, k.texW, rows, (v) => ((got.aux = v), done()))
    this.readback.read(k.genesFbo, gl.COLOR_ATTACHMENT0, 0, 0, k.texW * T, rows, (v) => ((got.genes = v), done()))
  }
}
