import { mutate } from '../sim/genetics.js'

/** Sim seconds between reads of who laid (at most one read in flight). */
const POLL_EVERY = 0.25
/** Above this many new eggs in one read, the genomes come back in one read of everyone. */
const BULK_GENOMES = 32

/**
 * Laying for a GPU species whose definition has `lays` (species/midges.js):
 * the shader marks a lay in the layer's aux1 (when: x, where: y, z) and
 * lays no other until `ack` (u_eggAck) passes that time. Here, every
 * POLL_EVERY sim s, aux and aux1 are read back; each lay since the last read
 * becomes an egg (def.egg: a boid in the egg mode, hatching after
 * `eggHatchTime` s) with a mutated copy of the layer's genome, in a slot
 * left empty or past the end (the count grows). Then `ack` moves up to the
 * read's time, so no lay is missed or counted twice.
 *
 * Along the way it counts, between reads: hatched (egg -> alive) and deaths
 * by cause (alive -> not, aux1[causeChannel]); and the eggs waiting.
 */
export class Laying {
  constructor(kernel, readback) {
    this.kernel = kernel
    this.readback = readback
    this.reset()
  }

  get def() {
    return this.kernel.def
  }

  /** A new flock: nothing read yet, counts from zero (any read in flight is dropped). */
  reset() {
    this.gen = (this.gen ?? 0) + 1
    this.busy = false
    this.ack = this.kernel.time
    this.readUpTo = this.kernel.time
    this.lastRead = -Infinity
    this.prev = null // each slot's mode at the last read
    this.laid = 0
    this.hatched = 0
    this.deaths = {}
    this.eggs = 0
  }

  /** Start a read if one is due (call once a frame, after stepping). */
  poll(params) {
    const k = this.kernel
    if (!this.def.lays || this.busy || !k.count || k.time - this.lastRead < POLL_EVERY) return
    const gl = k.gl
    const gen = this.gen
    const n = k.count
    const time = k.time
    const rows = Math.ceil(n / k.texW)
    const got = {}
    this.busy = true
    this.lastRead = time
    const done = () => {
      if (!got.aux || !got.aux1) return
      if (gen !== this.gen) return
      this.collect(got.aux, got.aux1, n, time, params)
    }
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT1, 0, 0, k.texW, rows, (v) => ((got.aux = v), done()))
    this.readback.read(k.currentFbo, gl.COLOR_ATTACHMENT2, 0, 0, k.texW, rows, (v) => ((got.aux1 = v), done()))
  }

  /** A read back: count changes, find the new lays and the free slots, then fetch the layers' genomes. */
  collect(aux, aux1, n, time, params) {
    const L = this.def.lays
    const alive = (m) => L.alive.includes(m)
    const lays = []
    const free = []
    let eggs = 0
    for (let i = 0; i < n; i++) {
      const mode = aux[i * 4 + L.modeChannel]
      const was = this.prev && i < this.prev.length ? this.prev[i] : mode
      if (was === L.egg && alive(mode)) this.hatched++
      if (alive(was) && !alive(mode) && mode !== L.egg) {
        const cause = aux1[i * 4 + L.causeChannel]
        this.deaths[cause] = (this.deaths[cause] ?? 0) + 1
      }
      if (mode === L.egg) eggs++
      if (mode === L.empty) free.push(i)
      const t = aux1[i * 4]
      if (t > this.readUpTo && t <= time) lays.push({ parent: i, x: aux1[i * 4 + 1], y: aux1[i * 4 + 2], t })
    }
    this.prev = Float32Array.from({ length: n }, (_, i) => aux[i * 4 + L.modeChannel])
    this.readUpTo = time
    this.eggs = eggs
    if (!lays.length) {
      this.ack = time
      this.busy = false
      return
    }
    this.genomes(lays, (genomeOf) => this.place(lays, genomeOf, free, time, params))
  }

  /** The layers' genomes: callback(genomeOf(lay)). */
  genomes(lays, callback) {
    const k = this.kernel
    const gl = k.gl
    const gen = this.gen
    const T = k.geneTexels
    const NG = this.def.genes.length
    if (lays.length > BULK_GENOMES) {
      const rows = Math.ceil(k.count / k.texW)
      this.readback.read(k.genesFbo, gl.COLOR_ATTACHMENT0, 0, 0, k.texW * T, rows, (g) => {
        if (gen === this.gen) callback((lay) => Array.from(g.subarray(lay.parent * T * 4, lay.parent * T * 4 + NG)))
      })
      return
    }
    const got = new Map()
    for (const lay of lays) {
      const i = lay.parent
      this.readback.read(k.genesFbo, gl.COLOR_ATTACHMENT0, (i & (k.texW - 1)) * T, i >> k.texShift, T, 1, (g) => {
        got.set(i, Array.from(g.subarray(0, NG)))
        if (got.size === lays.length && gen === this.gen) callback((lay) => got.get(lay.parent)) // one lay per layer a read
      })
    }
  }

  /** Each lay an egg: into the free slots, then past the end. */
  place(lays, genomeOf, free, time, params) {
    const k = this.kernel
    const genes = this.def.genes
    const boids = []
    let next = k.count
    for (const lay of lays) {
      const slot = free.length ? free.shift() : next++
      const parent = genomeOf(lay)
      const genome = params[this.def.lays.lockParam] ? parent : mutate(genes, parent, params.mutationRate, params.mutationSize, params.mutationFlip)
      boids.push({ slot, ...this.def.egg(lay.x, lay.y, genome, lay.t + params.eggHatchTime) })
    }
    k.place(boids)
    const L = this.def.lays
    if (k.count > this.prev.length) {
      const grown = new Float32Array(k.count).fill(L.empty)
      grown.set(this.prev)
      this.prev = grown
    }
    for (const b of boids) if (b.slot < this.prev.length) this.prev[b.slot] = L.egg
    this.laid += boids.length
    this.eggs += boids.length
    this.ack = time
    this.busy = false
  }
}
