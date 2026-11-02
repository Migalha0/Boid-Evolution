import { createFramebuffer, createProgram, createTexture, nextPow2, texDims, uploadRange } from '../gl.js'
import * as S from '../simShaders.js'
import { buildLookShader, buildUpdateShader, debugLayout, lookLayout } from './codegen.js'

export const MAX_BOIDS = 1 << 18
const MIN_CAPACITY = 1 << 10
const CELL_TEX_W = 256
/** Up to this capacity the O(n²) rank sort (2 passes) beats bitonic (40-70 passes). */
const RANK_MAX = 8192
/** Grid cells per largest range: finer cells skip more of the area outside it. */
const CELLS_PER_RANGE = 2
/**
 * Steps between sorts of the grid (sorting is most of a step's cost). In
 * between, positions are refreshed in the last sort's order and neighbours are
 * searched a little wider, by how far anyone may have moved since. Who is in
 * flight (modeChannel) is also as of the last sort, so this many steps late at
 * most.
 */
const SORT_EVERY = 8
/** Texture units: the base's, then the genes, what it last saw (lookLayout) and the species' own textures. */
const UNIT = { sortedKeys: 0, sorted: 1, cellTable: 2, prevState: 3, aux: 4, traits: 5, genes: 6 }

/** Grid passes, the same for every species: compiled once per GL context. */
const shared = new WeakMap()
function sharedPrograms(gl) {
  if (shared.has(gl)) return shared.get(gl)
  const progs = {
    hash: createProgram(gl, S.passVS, S.hashFS),
    sort: createProgram(gl, S.passVS, S.sortFS),
    gather: createProgram(gl, S.passVS, S.gatherFS),
    regather: createProgram(gl, S.passVS, S.regatherFS),
    cells: createProgram(gl, S.passVS, S.cellsFS),
    sortLocal: createProgram(gl, S.passVS, S.sortLocalFS),
    rank: createProgram(gl, S.passVS, S.rankFS),
    scatter: createProgram(gl, S.scatterVS, S.scatterFS),
    writeBack: createProgram(gl, S.writeBackVS(1), S.writeBackFS(1)),
    writeBack2: createProgram(gl, S.writeBackVS(2), S.writeBackFS(2)),
  }
  const bind = (prog, units) => {
    gl.useProgram(prog.program)
    for (const [name, unit] of Object.entries(units)) gl.uniform1i(prog.u[name], unit)
  }
  bind(progs.hash, { u_state: 0, u_aux: 1 })
  bind(progs.sort, { u_keys: 0 })
  bind(progs.gather, { u_keys: 0, u_state: 1 })
  bind(progs.regather, { u_sortedKeys: 0, u_state: 1 })
  bind(progs.cells, { u_sortedKeys: 0 })
  bind(progs.rank, { u_keys: 0 })
  bind(progs.scatter, { u_ranks: 0, u_state: 1, u_keys: 2 })
  bind(progs.sortLocal, { u_keys: 0 })
  bind(progs.writeBack, { u_nextState: 0, u_nextAux: 1, u_sortedKeys: 2 })
  bind(progs.writeBack2, { u_nextState: 0, u_nextAux: 1, u_sortedKeys: 2, u_nextAux1: 3 })
  shared.set(gl, progs)
  return progs
}

/**
 * The base boid on the GPU: one instance per species (fish, midges...), all
 * WebGL2 fragment-shader passes. A species is a definition (src/species/):
 * its genes, what it senses and how it acts, as GLSL the update shader is
 * built from (codegen.js), plus how to spawn one.
 *
 * Per step:
 *   hash    state -> (cellKey, index); with modes, boids not in flight file last
 *   sort    rank sort (capacity <= RANK_MAX, 2 passes) or bitonic, then the
 *           state is gathered into that order, so neighbour reads are coherent;
 *           only every SORT_EVERY steps (sooner if needed): in between the
 *           state is regathered in the last order and the search allows for
 *           the drift since (def.maxSpeed)
 *   cells   [start, end) of every grid cell via binary search
 *   look    (tick rate above 1) a share of the boids in turn sense the flock
 *           and items and keep it, at their own texels (codegen lookLayout);
 *           the update recalls it instead of sensing
 *   update  the species' generated shader, in sorted order -> next state & aux
 *   debug   (a boid selected) the same shader for that boid alone, its forces
 *           and seen counts into a small target (debugLayout)
 *   write   points put each boid's next state & aux back at its own texel
 *
 * Textures (one boid per texel, row-major, power-of-two width):
 *   state   RGBA32F (x, y, vx, vy)    ping-pong
 *   aux     RGBA32F species-defined   ping-pong
 *   aux1    RGBA32F species-defined   ping-pong, if def.auxTextures is 2
 *   traits  RGBA32F per-boid constants
 *   genes   RGBA32F, geneTexels (ceil(genes / 4)) texels side by side per
 *           boid, so one texture (one unit) for any genome
 *   look    RGBA32UI x lookLayout().textures: what each last sensed
 */
export class BoidKernel {
  constructor(gl, def, map) {
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser/GPU cannot render to float textures (EXT_color_buffer_float).')
    }
    this.gl = gl
    this.def = def
    this.map = map
    this.params = null
    this.progs = sharedPrograms(gl)
    this.update = createProgram(gl, S.passVS, buildUpdateShader(def))
    this.updateDebug = createProgram(gl, S.passVS, buildUpdateShader(def, true))
    // Sensing every few steps (the tick rate): the look pass and what it keeps (null: always every step).
    this.look = lookLayout(def)
    this.lookProg = this.look && createProgram(gl, S.passVS, buildLookShader(def))
    this.frame = 0
    this.lookEvery = 1
    this.lookAll = true // memories new or stale: everyone looks on the next step
    this.geneTexels = Math.max(1, Math.ceil(def.genes.length / 4))
    this.auxCount = def.auxTextures ?? 1
    const units = { u_sortedKeys: UNIT.sortedKeys, u_sorted: UNIT.sorted, u_cellTable: UNIT.cellTable, u_prevState: UNIT.prevState, u_aux: UNIT.aux, u_traits: UNIT.traits, u_genes: UNIT.genes }
    let unit = Object.keys(UNIT).length
    if (this.auxCount > 1) units.u_aux1 = unit++
    for (let t = 0; t < (this.look?.textures ?? 0); t++) units[`u_look${t}`] = unit++
    for (const name of def.textures) units[name] = unit++
    if (unit > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) throw new Error(`${def.name}: ${unit} textures, more than this GPU binds at once`)
    this.units = units
    for (const prog of [this.update, this.updateDebug, this.lookProg]) {
      if (!prog) continue
      gl.useProgram(prog.program)
      for (const [name, u] of Object.entries(units)) gl.uniform1i(prog.u[name], u)
    }
    // The selected boid's forces (debugLayout): which one (-1: none), and its target.
    this.layout = debugLayout(def)
    this.debugId = -1
    this.debugTex = createTexture(gl, gl.RGBA32F, this.layout.width, 1)
    this.debugFbo = createFramebuffer(gl, [this.debugTex])
    this.vao = gl.createVertexArray()

    this.width = 1
    this.height = 1
    this.rescale = [1, 1]
    this.count = 0
    this.capacity = 0
    this.cur = 0
    this.particle = null
    this.cellTex = null
    this.cellFbo = null
    this.cellRows = 0
    this.grid = null // the last sort: { cols, rows, cellW, cellH, since (steps), n }
    this.drift = 0
    this.time = 0 // sim time of the last step (s): when newcomers are born
  }

  get stateTexture() {
    return this.particle.state[this.cur]
  }
  get auxTexture() {
    return this.particle.aux[this.cur]
  }
  get aux1Texture() {
    return this.particle.aux1[this.cur]
  }
  get traitsTexture() {
    return this.particle.traits
  }
  /** The genome: geneTexels texels side by side per boid (gene k in texel k >> 2, channel k & 3). */
  get genesTexture() {
    return this.particle.genes
  }
  get genesFbo() {
    return this.particle.genesFbo
  }
  /** Framebuffer with the current state (attachment 0), aux (1) and aux1 (2, if any). */
  get currentFbo() {
    return this.particle.fbo[this.cur]
  }
  get traitsFbo() {
    return this.particle.traitsFbo
  }
  get texW() {
    return this.particle.w
  }
  get texShift() {
    return this.particle.shift
  }

  setBounds(width, height) {
    // Positions are rescaled on the GPU during the next update.
    if (this.count > 0) {
      this.rescale[0] *= width / this.width
      this.rescale[1] *= height / this.height
    }
    this.grid = null
    this.width = width
    this.height = height
  }

  /** `n` boids, keeping who is there; newcomers spawn (genome: one for all, or null for random). */
  setCount(n, params, genome = null) {
    this.params = params
    n = Math.max(0, Math.min(MAX_BOIDS, Math.round(n)))
    // With none the buffers still exist (the renderer and fields read them).
    if (n === this.count && this.particle) return
    const cap = Math.max(MIN_CAPACITY, nextPow2(n))
    if (n < this.count) this.count = n
    // Shrink with hysteresis: sort cost scales with capacity, not count.
    if (cap > this.capacity || cap * 4 <= this.capacity) this.allocate(cap, this.count)
    if (n > this.count) this.spawn(this.count, n, genome)
    this.count = n
  }

  /** Everyone afresh: new places (and genomes, from `genome` or random). */
  reset(params, genome = null) {
    this.params = params
    this.spawn(0, this.count, genome)
  }

  allocate(capacity, keep) {
    const gl = this.gl
    const old = keep > 0 && this.particle
      ? {
          state: this.readSync(this.currentFbo, gl.COLOR_ATTACHMENT0, keep),
          aux: this.readSync(this.currentFbo, gl.COLOR_ATTACHMENT1, keep),
          aux1: this.auxCount > 1 ? this.readSync(this.currentFbo, gl.COLOR_ATTACHMENT2, keep) : null,
          traits: this.readSync(this.traitsFbo, gl.COLOR_ATTACHMENT0, keep),
          genes: this.readSync(this.genesFbo, gl.COLOR_ATTACHMENT0, keep, this.geneTexels),
        }
      : null
    this.freeParticles()

    const [w, h] = texDims(capacity)
    const tex = (fmt) => createTexture(gl, fmt, w, h)
    const state = [tex(gl.RGBA32F), tex(gl.RGBA32F)]
    const aux = [tex(gl.RGBA32F), tex(gl.RGBA32F)]
    const aux1 = this.auxCount > 1 ? [tex(gl.RGBA32F), tex(gl.RGBA32F)] : []
    const keys = [tex(gl.R32UI), tex(gl.R32UI)]
    const sorted = tex(gl.RGBA32F)
    const sortedKeys = tex(gl.R32UI)
    const next = Array.from({ length: 1 + this.auxCount }, () => tex(gl.RGBA32F))
    const traits = tex(gl.RGBA32F)
    const genes = createTexture(gl, gl.RGBA32F, w * this.geneTexels, h)
    // What each last sensed: not kept on reallocating (everyone looks again on the next step).
    const look = Array.from({ length: this.look?.textures ?? 0 }, () => tex(gl.RGBA32UI))
    this.particle = {
      w,
      h,
      shift: Math.log2(w),
      state,
      aux,
      aux1,
      keys,
      sorted,
      sortedKeys,
      next,
      traits,
      genes,
      look,
      lookFbo: look.length ? createFramebuffer(gl, look) : null,
      fbo: [0, 1].map((k) => createFramebuffer(gl, [state[k], aux[k], ...aux1.slice(k, k + 1)])),
      keyFbo: [createFramebuffer(gl, [keys[0]]), createFramebuffer(gl, [keys[1]])],
      sortedFbo: createFramebuffer(gl, [sorted, sortedKeys]),
      sortedStateFbo: createFramebuffer(gl, [sorted]),
      nextFbo: createFramebuffer(gl, next),
      traitsFbo: createFramebuffer(gl, [traits]),
      genesFbo: createFramebuffer(gl, [genes]),
      // Partial ranks, RANK_CHUNKS side by side (rank sort only).
      ranks: null,
      ranksFbo: null,
    }
    if (capacity <= RANK_MAX) {
      this.particle.ranks = createTexture(gl, gl.R32UI, w * S.RANK_CHUNKS, h)
      this.particle.ranksFbo = createFramebuffer(gl, [this.particle.ranks])
    }
    this.capacity = capacity
    this.cur = 0
    this.lookAll = true
    this.grid = null
    if (old) {
      uploadRange(gl, state[0], w, 0, old.state)
      uploadRange(gl, aux[0], w, 0, old.aux)
      if (old.aux1) uploadRange(gl, aux1[0], w, 0, old.aux1)
      uploadRange(gl, traits, w, 0, old.traits)
      uploadRange(gl, genes, w * this.geneTexels, 0, old.genes)
    }
  }

  /** Blocking read of the first n boids' texels, `per` texels each (only when reallocating). */
  readSync(fbo, attachment, n, per = 1) {
    const gl = this.gl
    const { w } = this.particle
    const rows = Math.ceil(n / w)
    const buf = new Float32Array(w * per * rows * 4)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    gl.readBuffer(attachment)
    gl.readPixels(0, 0, w * per, rows, gl.RGBA, gl.FLOAT, buf)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    return buf.subarray(0, n * per * 4)
  }

  /** Boids start..end-1 afresh at random spots in the water (the species says the rest). */
  spawn(start, end, genome = null) {
    const n = end - start
    if (n <= 0) return
    const boids = []
    for (let i = 0; i < n; i++) {
      const [x, y] = this.map.randomPoint()
      boids.push(this.def.spawn(x, y, this.params, typeof genome === 'function' ? genome() : genome, this.time))
    }
    this.upload(start, boids)
    // Newcomers sense on their first step (not recall what the last one in their slot did), from a fresh sort.
    this.lookAll = true
    this.grid = null
  }

  /** Boids as def.spawn makes them ({ state, aux, aux1, traits, genome }) into slots start.. on. */
  upload(start, boids) {
    const n = boids.length
    const T = this.geneTexels
    const state = new Float32Array(n * 4)
    const aux = new Float32Array(n * 4)
    const aux1 = new Float32Array(n * 4)
    const traits = new Float32Array(n * 4)
    const genes = new Float32Array(n * T * 4)
    boids.forEach((b, i) => {
      state.set(b.state, i * 4)
      aux.set(b.aux, i * 4)
      if (b.aux1) aux1.set(b.aux1, i * 4)
      traits.set(b.traits, i * 4)
      if (b.genome) genes.set(b.genome, i * T * 4)
    })
    const { w } = this.particle
    uploadRange(this.gl, this.stateTexture, w, start, state)
    uploadRange(this.gl, this.auxTexture, w, start, aux)
    if (this.auxCount > 1) uploadRange(this.gl, this.aux1Texture, w, start, aux1)
    uploadRange(this.gl, this.traitsTexture, w, start, traits)
    uploadRange(this.gl, this.genesTexture, w * T, start * T, genes)
  }

  /**
   * Newcomers into given slots (births): `boids` [{ slot, ...as def.spawn
   * makes them }]. Slots at or past the count grow it; every slot up to the
   * new count must be filled. They keep the grid and memories as they are
   * (they sense on their next turn).
   */
  place(boids) {
    if (!boids.length) return
    const top = Math.max(...boids.map((b) => b.slot)) + 1
    if (top > this.count) {
      const cap = Math.max(MIN_CAPACITY, nextPow2(top))
      if (cap > this.capacity) this.allocate(cap, this.count)
      this.count = Math.min(MAX_BOIDS, top)
    }
    for (const b of boids) if (b.slot < this.count) this.upload(b.slot, [b])
  }

  /** Every boid's genome from `genomeOf(i)` (an array per boid), e.g. a profile applied. */
  writeGenes(genomeOf) {
    const n = this.count
    const T = this.geneTexels
    const genes = new Float32Array(n * T * 4)
    for (let i = 0; i < n; i++) genes.set(genomeOf(i), i * T * 4)
    uploadRange(this.gl, this.genesTexture, this.particle.w * T, 0, genes)
  }

  ensureCellTable(cells) {
    const rows = Math.ceil(cells / CELL_TEX_W)
    if (rows === this.cellRows) return
    const gl = this.gl
    gl.deleteTexture(this.cellTex)
    gl.deleteFramebuffer(this.cellFbo)
    this.cellTex = createTexture(gl, gl.RG32UI, CELL_TEX_W, rows)
    this.cellFbo = createFramebuffer(gl, [this.cellTex])
    this.cellRows = rows
  }

  /** useProgram + target + viewport + layout uniforms. */
  begin(prog, fbo, w, h) {
    const gl = this.gl
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, w, h)
    gl.uniform1i(prog.u.u_texW, this.particle.w)
    gl.uniform1i(prog.u.u_texShift, this.particle.shift)
  }

  bindTex(unit, tex) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
  }

  /** The update shader's uniforms (shared with its debug variant). */
  updateUniforms(u, ctx, dt, n) {
    const gl = this.gl
    const g = this.grid
    gl.uniform1i(u.u_count, n)
    gl.uniform2f(u.u_world, this.width, this.height)
    gl.uniform2f(u.u_rescale, this.rescale[0], this.rescale[1])
    gl.uniform2f(u.u_cellSize, g.cellW, g.cellH)
    gl.uniform2i(u.u_grid, g.cols, g.rows)
    gl.uniform1i(u.u_cellTexW, CELL_TEX_W)
    gl.uniform1f(u.u_drift, this.drift)
    gl.uniform1f(u.u_dt, dt)
    gl.uniform1f(u.u_time, ctx.time ?? 0)
    gl.uniform1i(u.u_lookEvery, this.lookEvery)
    this.def.setUniforms(gl, u, ctx)
  }

  /** Bind the textures every species program reads (by this.units). */
  bindInputs(ctx) {
    const P = this.particle
    const u = this.units
    this.bindTex(u.u_sortedKeys, P.sortedKeys)
    this.bindTex(u.u_sorted, P.sorted)
    this.bindTex(u.u_cellTable, this.cellTex)
    this.bindTex(u.u_prevState, P.state[this.cur])
    this.bindTex(u.u_aux, P.aux[this.cur])
    this.bindTex(u.u_traits, P.traits)
    this.bindTex(u.u_genes, P.genes)
    if (this.auxCount > 1) this.bindTex(u.u_aux1, P.aux1[this.cur])
    const own = this.def.bindTextures(ctx)
    for (const name of this.def.textures) this.bindTex(u[name], own[name])
  }

  /**
   * One step of `dt` s. `ctx`: { params, mapTex, time, ... } as the species'
   * bindTextures / setUniforms need.
   */
  step(dt, ctx) {
    const n = this.count
    if (!n) return
    this.params = ctx.params
    this.time = ctx.time ?? 0
    const gl = this.gl
    const P = this.particle
    const { update, updateDebug } = this

    const activeRows = Math.ceil(n / P.w)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)

    // Sort the grid every SORT_EVERY steps, or sooner: the count changed, or
    // the range plus the drift since would reach past the cells searched.
    const range = this.def.maxRange(ctx.params)
    const perStep = this.def.maxSpeed(ctx.params) * dt
    const g = this.grid
    if (!g || g.n !== n || g.since + 1 >= SORT_EVERY || range + perStep * (g.since + 1) > CELLS_PER_RANGE * Math.min(g.cellW, g.cellH)) {
      // Cells wide enough for the range plus the drift until the next sort
      // (coarser if the world would need too many cells for the keys).
      const cell = Math.max((range + perStep * (SORT_EVERY - 1)) / CELLS_PER_RANGE, Math.sqrt((this.width * this.height) / S.MAX_CELLS))
      const cols = Math.max(1, Math.floor(this.width / cell))
      const rows = Math.max(1, Math.floor(this.height / cell))
      this.grid = { cols, rows, cellW: this.width / cols, cellH: this.height / rows, since: 0, n }
      this.drift = 0
      this.ensureCellTable(cols * rows)
      this.buildGrid(n, cols, rows, this.grid.cellW, this.grid.cellH, activeRows)
    } else {
      g.since++
      this.drift = perStep * g.since
      this.regather(n, activeRows)
    }
    this.bindInputs(ctx)

    // look (own texels; those not looking this step are discarded, keeping what they sensed)
    const every = this.look ? Math.max(1, Math.round(ctx.params[this.def.tickParam] ?? 1)) : 1
    if (every !== this.lookEvery) {
      // Coming from every step, memories are stale: everyone looks now.
      if (this.lookEvery === 1) this.lookAll = true
      this.lookEvery = every
    }
    if (every > 1) {
      // Turns by bands of rows, one band a step (everyone when memories are new):
      // whole blocks of the GPU's threads look or skip together.
      const band = Math.ceil(activeRows / every)
      const y0 = this.lookAll ? 0 : (this.frame % every) * band
      const rows = this.lookAll ? activeRows : Math.min(band, activeRows - y0)
      if (rows > 0) {
        this.begin(this.lookProg, P.lookFbo, P.w, activeRows)
        gl.viewport(0, y0, P.w, rows)
        this.updateUniforms(this.lookProg.u, ctx, dt, n)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
    }

    // update (sorted order) -> next
    P.look.forEach((t, k) => this.bindTex(this.units[`u_look${k}`], t))
    this.begin(update, P.nextFbo, P.w, activeRows)
    this.updateUniforms(update.u, ctx, dt, n)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // The selected boid again, its forces apart (the same textures are still bound).
    if (this.debugId >= 0 && this.debugId < n) {
      this.begin(updateDebug, this.debugFbo, this.layout.width, 1)
      this.updateUniforms(updateDebug.u, ctx, dt, n)
      gl.uniform1i(updateDebug.u.u_debugId, this.debugId)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // back to each boid's own texel -> other ping-pong side
    const writeBack = this.auxCount > 1 ? this.progs.writeBack2 : this.progs.writeBack
    this.begin(writeBack, P.fbo[1 - this.cur], P.w, P.h)
    this.bindTex(0, P.next[0])
    this.bindTex(1, P.next[1])
    this.bindTex(2, P.sortedKeys)
    if (this.auxCount > 1) this.bindTex(3, P.next[2])
    gl.uniform2f(writeBack.u.u_dims, P.w, P.h)
    gl.drawArrays(gl.POINTS, 0, n)

    this.cur = 1 - this.cur
    this.frame++
    if (every > 1) this.lookAll = false
    this.rescale[0] = this.rescale[1] = 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
  }

  /** Between sorts: the state in the last sort's order again -> P.sorted. */
  regather(n, activeRows) {
    const P = this.particle
    const { regather } = this.progs
    this.begin(regather, P.sortedStateFbo, P.w, activeRows)
    this.bindTex(0, P.sortedKeys)
    this.bindTex(1, P.state[this.cur])
    this.gl.uniform1i(regather.u.u_count, n)
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
  }

  /** Passes 1-4: sort boids by grid cell and index each cell's range. */
  buildGrid(n, cols, rows, cellW, cellH, activeRows) {
    const gl = this.gl
    const P = this.particle
    const { hash, rank, scatter, cells } = this.progs

    // 1. hash (whole texture: padding must get the max key)
    this.begin(hash, P.keyFbo[0], P.w, P.h)
    this.bindTex(0, P.state[this.cur])
    this.bindTex(1, P.aux[this.cur])
    gl.uniform1i(hash.u.u_modeChannel, this.def.modeChannel)
    gl.uniform1i(hash.u.u_count, n)
    gl.uniform2f(hash.u.u_cellSize, cellW, cellH)
    gl.uniform2i(hash.u.u_grid, cols, rows)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 2-3. sort by key and copy state into that order -> P.sorted
    if (P.ranks) {
      this.begin(rank, P.ranksFbo, P.w * S.RANK_CHUNKS, activeRows)
      this.bindTex(0, P.keys[0])
      gl.uniform1i(rank.u.u_count, n)
      gl.uniform1i(rank.u.u_chunk, Math.ceil(n / S.RANK_CHUNKS))
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      this.begin(scatter, P.sortedFbo, P.w, P.h)
      this.bindTex(0, P.ranks)
      this.bindTex(1, P.state[this.cur])
      this.bindTex(2, P.keys[0])
      gl.uniform2f(scatter.u.u_dims, P.w, P.h)
      gl.drawArrays(gl.POINTS, 0, n)
    } else {
      this.bitonicGather(n, activeRows)
    }

    // 4. cell ranges
    this.begin(cells, this.cellFbo, CELL_TEX_W, this.cellRows)
    this.bindTex(0, P.sortedKeys)
    gl.uniform1i(cells.u.u_count, n)
    gl.uniform1i(cells.u.u_cells, cols * rows)
    gl.uniform1i(cells.u.u_cellTexW, CELL_TEX_W)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Large flocks: bitonic sort of the keys, then gather the state into that order. */
  bitonicGather(n, activeRows) {
    const gl = this.gl
    const P = this.particle
    const { sort, sortLocal, gather } = this.progs
    // Bitonic sort: blocks first, then per stage the long-range steps a few
    // per pass and the in-block steps in one local pass.
    let src = 0
    const pass = (prog, k, j, steps) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, P.keyFbo[1 - src])
      this.bindTex(0, P.keys[src])
      gl.uniform1i(prog.u.u_k, k)
      if (j) {
        gl.uniform1i(prog.u.u_j, j)
        gl.uniform1i(prog.u.u_steps, steps)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      src = 1 - src
    }
    this.begin(sortLocal, P.keyFbo[1], P.w, P.h)
    pass(sortLocal, S.SORT_BLOCK)
    for (let k = S.SORT_BLOCK * 2; k <= this.capacity; k <<= 1) {
      this.begin(sort, P.keyFbo[1], P.w, P.h)
      for (let j = k >> 1; j >= S.SORT_BLOCK; ) {
        const steps = Math.min(S.SORT_FUSE, Math.log2(j / S.SORT_BLOCK) + 1)
        pass(sort, k, j, steps)
        j >>= steps
      }
      this.begin(sortLocal, P.keyFbo[1], P.w, P.h)
      pass(sortLocal, k)
    }
    this.begin(gather, P.sortedFbo, P.w, activeRows)
    this.bindTex(0, P.keys[src])
    this.bindTex(1, P.state[this.cur])
    gl.uniform1i(gather.u.u_count, n)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * The debug pass's result as { forces: { key: [x, y] }, seen: { key: n },
   * pos, vel } from its raw texels (Readback of debugFbo, layout.width wide).
   */
  decodeDebug(d) {
    const L = this.layout
    const forces = {}
    this.def.forces.forEach(([key], k) => (forces[key] = [d[k * 2], d[k * 2 + 1]]))
    const seen = {}
    L.senses.forEach((key, k) => (seen[key === 'flock' ? this.def.senses.find((s) => s.kind === 'flock').key : key] = d[L.forceTexels * 4 + k]))
    const o = L.stateTexel * 4
    return { forces, seen, pos: [d[o], d[o + 1]], vel: [d[o + 2], d[o + 3]] }
  }

  freeParticles() {
    const P = this.particle
    if (!P) return
    const gl = this.gl
    for (const t of [...P.state, ...P.aux, ...P.aux1, ...P.keys, ...P.next, P.sorted, P.sortedKeys, P.traits, P.ranks, P.genes, ...P.look]) gl.deleteTexture(t)
    for (const f of [...P.fbo, ...P.keyFbo, P.sortedFbo, P.sortedStateFbo, P.nextFbo, P.traitsFbo, P.ranksFbo, P.genesFbo, P.lookFbo]) gl.deleteFramebuffer(f)
    this.particle = null
  }

  destroy() {
    const gl = this.gl
    this.freeParticles()
    gl.deleteProgram(this.update.program)
    gl.deleteProgram(this.updateDebug.program)
    if (this.lookProg) gl.deleteProgram(this.lookProg.program)
    gl.deleteTexture(this.cellTex)
    gl.deleteFramebuffer(this.cellFbo)
    gl.deleteTexture(this.debugTex)
    gl.deleteFramebuffer(this.debugFbo)
    gl.deleteVertexArray(this.vao)
  }
}
