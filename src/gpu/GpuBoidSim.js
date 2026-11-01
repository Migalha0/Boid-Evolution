import { createFramebuffer, createProgram, createTexture, nextPow2, texDims, uploadRange } from './gl.js'
import * as S from './simShaders.js'
import { LOG_ELEV_PER_PX } from '../sim/Logs.js'
import { LAND_LEVEL } from '../sim/PondMap.js'

export const MAX_BOIDS = 1 << 18
/** Koi colours, indexed by traits.x. Kept in sync with PALETTE in render/shaders.js. */
export const BOID_COLORS = ['gold', 'blue', 'white', 'orange', 'black']
const MIN_CAPACITY = 1 << 10
const CELL_TEX_W = 256
const BEHAVIOR_SLOTS = 256
/** Up to this capacity the O(n²) rank sort (2 passes) beats bitonic (40-70 passes). */
const RANK_MAX = 8192
/** Grid cells per vision range: finer cells skip more of the area outside it. */
const CELLS_PER_RANGE = 2
/** Candidates a boid looks at, per neighbour it may count: bounds the cost in crowds. */
const SCAN_PER_NEIGHBOR = 6

/**
 * Boid simulation running entirely on the GPU (WebGL2 fragment-shader GPGPU).
 *
 * Per step:
 *   hash    state -> (cellKey, index)
 *   sort    small flocks (capacity <= RANK_MAX): rank sort, 2 passes —
 *             rank: every boid counts the smaller keys; scatter: points at their rank
 *           large flocks: bitonic sort of the keys, log2(N)·(log2(N)+1)/2 steps
 *             (the steps within blocks of SORT_BLOCK merged into one pass), then
 *             gather the state into that order
 *           either way the state ends up reordered by cell, so neighbour reads are coherent
 *   cells   [start, end) of every grid cell via binary search
 *   update  neighbour search + steering + shore avoidance + integration, in sorted
 *           order (fish in one warp read the same cells) -> next state & aux (MRT)
 *   write   points put each boid's next state & aux back at its own texel
 *
 * Textures (one boid per texel, row-major, power-of-two width):
 *   state   RGBA32F  (x, y, vx, vy)                 ping-pong
 *   aux     RGBA32F  (ax, ay, neighbours, tail phase) ping-pong, for visualisation
 *   traits  RGBA32F  (colour index, swim depth, phase offset, -) per-boid constants; room for a genome
 */
export class GpuBoidSim {
  constructor(gl, params, field, map) {
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser/GPU cannot render to float textures (EXT_color_buffer_float).')
    }
    this.gl = gl
    this.params = params
    this.field = field
    this.map = map

    this.progs = {
      hash: createProgram(gl, S.passVS, S.hashFS),
      sort: createProgram(gl, S.passVS, S.sortFS),
      gather: createProgram(gl, S.passVS, S.gatherFS),
      cells: createProgram(gl, S.passVS, S.cellsFS),
      sortLocal: createProgram(gl, S.passVS, S.sortLocalFS),
      rank: createProgram(gl, S.passVS, S.rankFS),
      scatter: createProgram(gl, S.scatterVS, S.scatterFS),
      update: createProgram(gl, S.passVS, S.updateFS),
      writeBack: createProgram(gl, S.writeBackVS, S.writeBackFS),
    }
    this.bindSamplers(this.progs.hash, { u_state: 0 })
    this.bindSamplers(this.progs.sort, { u_keys: 0 })
    this.bindSamplers(this.progs.gather, { u_keys: 0, u_state: 1 })
    this.bindSamplers(this.progs.cells, { u_sortedKeys: 0 })
    this.bindSamplers(this.progs.rank, { u_keys: 0 })
    this.bindSamplers(this.progs.scatter, { u_ranks: 0, u_state: 1, u_keys: 2 })
    this.bindSamplers(this.progs.sortLocal, { u_keys: 0 })
    this.bindSamplers(this.progs.writeBack, { u_nextState: 0, u_nextAux: 1, u_sortedKeys: 2 })
    this.bindSamplers(this.progs.update, { u_sortedKeys: 0, u_sorted: 1, u_cellTable: 2, u_labels: 3, u_behaviors: 4, u_sdf: 5, u_aux: 6, u_traits: 7, u_elev: 8, u_trunkMap: 9 })
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

    this.behaviorTex = createTexture(gl, gl.RGBA32F, BEHAVIOR_SLOTS, 1)
    this.behaviorData = new Float32Array(BEHAVIOR_SLOTS * 4)
    this.labelTex = null
    this.labelDims = [0, 0]
    this.fieldVersion = -1
  }

  bindSamplers(prog, units) {
    this.gl.useProgram(prog.program)
    for (const [name, unit] of Object.entries(units)) this.gl.uniform1i(prog.u[name], unit)
  }

  get stateTexture() {
    return this.particle.state[this.cur]
  }
  get auxTexture() {
    return this.particle.aux[this.cur]
  }
  get traitsTexture() {
    return this.particle.traits
  }
  /** Framebuffer with the current state (attachment 0) and aux (attachment 1). */
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
    this.width = width
    this.height = height
  }

  setCount(n) {
    n = Math.max(0, Math.min(MAX_BOIDS, Math.round(n)))
    // With no fish the buffers still exist (the renderer and fields read them).
    if (n === this.count && this.particle) return
    const cap = Math.max(MIN_CAPACITY, nextPow2(n))
    if (n < this.count) this.count = n
    // Shrink with hysteresis: sort cost scales with capacity, not count.
    if (cap > this.capacity || cap * 4 <= this.capacity) this.allocate(cap, this.count)
    if (n > this.count) this.spawn(this.count, n)
    this.count = n
  }

  reset() {
    this.spawn(0, this.count)
  }

  allocate(capacity, keep) {
    const gl = this.gl
    const oldState = keep > 0 ? this.readSync(this.currentFbo, gl.COLOR_ATTACHMENT0, keep) : null
    const oldTraits = keep > 0 ? this.readSync(this.traitsFbo, gl.COLOR_ATTACHMENT0, keep) : null
    this.freeParticles()

    const [w, h] = texDims(capacity)
    const tex = (fmt) => createTexture(gl, fmt, w, h)
    const state = [tex(gl.RGBA32F), tex(gl.RGBA32F)]
    const aux = [tex(gl.RGBA32F), tex(gl.RGBA32F)]
    const keys = [tex(gl.R32UI), tex(gl.R32UI)]
    const sorted = tex(gl.RGBA32F)
    const sortedKeys = tex(gl.R32UI)
    const next = [tex(gl.RGBA32F), tex(gl.RGBA32F)]
    const traits = tex(gl.RGBA32F)
    this.particle = {
      w,
      h,
      shift: Math.log2(w),
      state,
      aux,
      keys,
      sorted,
      sortedKeys,
      next,
      traits,
      fbo: [createFramebuffer(gl, [state[0], aux[0]]), createFramebuffer(gl, [state[1], aux[1]])],
      keyFbo: [createFramebuffer(gl, [keys[0]]), createFramebuffer(gl, [keys[1]])],
      sortedFbo: createFramebuffer(gl, [sorted, sortedKeys]),
      nextFbo: createFramebuffer(gl, next),
      traitsFbo: createFramebuffer(gl, [traits]),
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
    if (oldState) uploadRange(gl, state[0], w, 0, oldState)
    if (oldTraits) uploadRange(gl, traits, w, 0, oldTraits)
  }

  /** Blocking read of the first n texels; only used when reallocating. */
  readSync(fbo, attachment, n) {
    const gl = this.gl
    const { w } = this.particle
    const rows = Math.ceil(n / w)
    const buf = new Float32Array(w * rows * 4)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    gl.readBuffer(attachment)
    gl.readPixels(0, 0, w, rows, gl.RGBA, gl.FLOAT, buf)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    return buf.subarray(0, n * 4)
  }

  readStateSync(n) {
    return this.readSync(this.currentFbo, this.gl.COLOR_ATTACHMENT0, n)
  }

  spawn(start, end) {
    const { minSpeed, maxSpeed } = this.params
    const n = end - start
    const state = new Float32Array(n * 4)
    const traits = new Float32Array(n * 4)
    for (let i = 0; i < n * 4; i += 4) {
      const [x, y] = this.map.randomPoint()
      const a = Math.random() * Math.PI * 2
      const v = minSpeed + Math.random() * (maxSpeed - minSpeed)
      state[i] = x
      state[i + 1] = y
      state[i + 2] = Math.cos(a) * v
      state[i + 3] = Math.sin(a) * v
      traits[i] = Math.floor(Math.random() * BOID_COLORS.length)
      traits[i + 1] = Math.random() // swimming depth, as a fraction of the water depth
      traits[i + 2] = Math.random() // tail-beat phase offset, so fish don't swim in step
    }
    uploadRange(this.gl, this.stateTexture, this.particle.w, start, state)
    uploadRange(this.gl, this.traitsTexture, this.particle.w, start, traits)
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

  syncField() {
    const f = this.field
    if (f.version === this.fieldVersion && this.labelTex) return
    const gl = this.gl
    const cols = Math.max(1, f.cols)
    const rows = Math.max(1, f.rows)
    if (!this.labelTex || cols !== this.labelDims[0] || rows !== this.labelDims[1]) {
      gl.deleteTexture(this.labelTex)
      this.labelTex = createTexture(gl, gl.R8UI, cols, rows)
      this.labelDims = [cols, rows]
    }
    if (f.labels.length === cols * rows) {
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, f.labels)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
    f.toBehaviorTable(this.behaviorData)
    gl.bindTexture(gl.TEXTURE_2D, this.behaviorTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BEHAVIOR_SLOTS, 1, gl.RGBA, gl.FLOAT, this.behaviorData)
    this.fieldVersion = f.version
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

  /** @param {import('./MapTextures.js').MapTextures} mapTex */
  step(dt, mapTex) {
    const n = this.count
    if (!n) return
    const gl = this.gl
    const p = this.params
    const P = this.particle
    const { update } = this.progs

    this.syncField()
    // (coarser if the world would need too many cells for the keys)
    const cell = Math.max(p.perception / CELLS_PER_RANGE, Math.sqrt((this.width * this.height) / S.MAX_CELLS))
    const cols = Math.max(1, Math.floor(this.width / cell))
    const rows = Math.max(1, Math.floor(this.height / cell))
    const cellW = this.width / cols
    const cellH = this.height / rows
    this.ensureCellTable(cols * rows)
    const activeRows = Math.ceil(n / P.w)

    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    this.buildGrid(n, cols, rows, cellW, cellH, activeRows)

    // 5. update (sorted order) -> next
    const u = update.u
    this.begin(update, P.nextFbo, P.w, activeRows)
    this.bindTex(0, P.sortedKeys)
    this.bindTex(1, P.sorted)
    this.bindTex(2, this.cellTex)
    this.bindTex(3, this.labelTex)
    this.bindTex(4, this.behaviorTex)
    this.bindTex(5, mapTex.sdf)
    this.bindTex(6, P.aux[this.cur])
    this.bindTex(7, P.traits)
    this.bindTex(8, mapTex.elevation)
    this.bindTex(9, mapTex.trunkMap)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_sdfCell, mapTex.sdfCell)
    gl.uniform1f(u.u_elevCell, mapTex.elevCell)
    gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
    gl.uniform1f(u.u_landLevel, LAND_LEVEL)
    gl.uniform4fv(u['u_logs[0]'], mapTex.logUniforms)
    gl.uniform1i(u.u_logCount, mapTex.logCount)
    gl.uniform1f(u.u_logElevPerPx, LOG_ELEV_PER_PX)
    gl.uniform1i(u.u_count, n)
    gl.uniform2f(u.u_world, this.width, this.height)
    gl.uniform2f(u.u_rescale, this.rescale[0], this.rescale[1])
    gl.uniform2f(u.u_cellSize, cellW, cellH)
    gl.uniform2i(u.u_grid, cols, rows)
    gl.uniform1i(u.u_cellTexW, CELL_TEX_W)
    gl.uniform1f(u.u_dt, dt)
    gl.uniform1f(u.u_perception, p.perception)
    gl.uniform1f(u.u_separation, p.separation)
    gl.uniform1f(u.u_cosHalfFov, Math.cos(((p.fov * Math.PI) / 180) * 0.5))
    gl.uniform1i(u.u_fullFov, p.fov >= 359.9 ? 1 : 0)
    gl.uniform1f(u.u_minSpeed, p.minSpeed)
    gl.uniform1f(u.u_maxSpeed, p.maxSpeed)
    gl.uniform1f(u.u_maxForce, p.maxForce)
    gl.uniform1i(u.u_maxNeighbors, p.maxNeighbors)
    gl.uniform1i(u.u_scanBudget, p.maxNeighbors * SCAN_PER_NEIGHBOR)
    gl.uniform3f(u.u_weights, p.alignWeight, p.cohesionWeight, p.separationWeight)
    gl.uniform1f(u.u_wallWeight, p.wallWeight)
    gl.uniform1f(u.u_beat, p.swimBeat)
    gl.uniform1i(u.u_fieldActive, this.field.active ? 1 : 0)
    gl.uniform1f(u.u_fieldCell, this.field.cellSize)
    gl.uniform2i(u.u_fieldDims, this.labelDims[0], this.labelDims[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 6. back to each boid's own texel -> other ping-pong side
    const { writeBack } = this.progs
    this.begin(writeBack, P.fbo[1 - this.cur], P.w, P.h)
    this.bindTex(0, P.next[0])
    this.bindTex(1, P.next[1])
    this.bindTex(2, P.sortedKeys)
    gl.uniform2f(writeBack.u.u_dims, P.w, P.h)
    gl.drawArrays(gl.POINTS, 0, n)

    this.cur = 1 - this.cur
    this.rescale[0] = this.rescale[1] = 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
  }

  /** Passes 1-4: sort boids by grid cell and index each cell's range. */
  buildGrid(n, cols, rows, cellW, cellH, activeRows) {
    const gl = this.gl
    const P = this.particle
    const { hash, rank, scatter, cells } = this.progs

    // 1. hash (whole texture: padding must get the max key)
    this.begin(hash, P.keyFbo[0], P.w, P.h)
    this.bindTex(0, P.state[this.cur])
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

    // 2. bitonic sort: blocks first, then per stage the long-range steps a
    // few per pass and the in-block steps in one local pass.
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
    const sortedKeys = P.keys[src]

    // 3. gather
    this.begin(gather, P.sortedFbo, P.w, activeRows)
    this.bindTex(0, sortedKeys)
    this.bindTex(1, P.state[this.cur])
    gl.uniform1i(gather.u.u_count, n)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  freeParticles() {
    const P = this.particle
    if (!P) return
    const gl = this.gl
    for (const t of [...P.state, ...P.aux, ...P.keys, ...P.next, P.sorted, P.sortedKeys, P.traits, P.ranks]) gl.deleteTexture(t)
    for (const f of [...P.fbo, ...P.keyFbo, P.sortedFbo, P.nextFbo, P.traitsFbo, P.ranksFbo]) gl.deleteFramebuffer(f)
    this.particle = null
  }

  destroy() {
    const gl = this.gl
    this.freeParticles()
    for (const p of Object.values(this.progs)) gl.deleteProgram(p.program)
    gl.deleteTexture(this.cellTex)
    gl.deleteFramebuffer(this.cellFbo)
    gl.deleteTexture(this.labelTex)
    gl.deleteTexture(this.behaviorTex)
    gl.deleteVertexArray(this.vao)
  }
}
