import { createTexture } from '../gl.js'

/** Grid cell for items (px). */
export const ITEM_CELL = 64
/**
 * A second, fine grid of the same items (px), for finding what is right
 * under a boid (a few px away): its cell holds a handful of items where a
 * 64 px cell holds hundreds.
 */
export const FINE_CELL = 8
const ITEMS_W = 1024
const CELLS_W = 256

/** Every source's items sorted by grid cell (counting sort) of `cell` px, and each cell's [start, end). */
function sortByCell(sources, width, height, cell) {
  const gw = Math.max(1, Math.ceil(width / cell))
  const gh = Math.max(1, Math.ceil(height / cell))
  const cells = gw * gh
  const total = sources.reduce((n, s) => n + s.length / 3, 0)
  const start = new Uint32Array(cells + 1)
  const keyOf = new Uint32Array(total)
  let n = 0
  sources.forEach((pts) => {
    for (let i = 0; i < pts.length; i += 3) {
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(pts[i] / cell)))
      const cy = Math.min(gh - 1, Math.max(0, Math.floor(pts[i + 1] / cell)))
      const key = cy * gw + cx
      keyOf[n++] = key
      start[key + 1]++
    }
  })
  for (let k = 0; k < cells; k++) start[k + 1] += start[k]
  const fill = start.slice(0, cells)
  const rows = Math.max(1, Math.ceil(total / ITEMS_W))
  const items = new Float32Array(ITEMS_W * rows * 4)
  n = 0
  sources.forEach((pts, src) => {
    for (let i = 0; i < pts.length; i += 3) {
      const o = fill[keyOf[n++]]++ * 4
      items[o] = pts[i]
      items[o + 1] = pts[i + 1]
      items[o + 2] = pts[i + 2]
      items[o + 3] = src
    }
  })
  const cellRows = Math.max(1, Math.ceil(cells / CELLS_W))
  const table = new Uint32Array(CELLS_W * cellRows * 2)
  for (let k = 0; k < cells; k++) {
    table[k * 2] = start[k]
    table[k * 2 + 1] = start[k + 1]
  }
  return { items, rows, table, cellRows, grid: [gw, gh], total }
}

/** The textures of a sorted grid: its items (RGBA32F) and its cell table (RG32UI). */
function upload(gl, g) {
  const items = createTexture(gl, gl.RGBA32F, ITEMS_W, g.rows)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ITEMS_W, g.rows, gl.RGBA, gl.FLOAT, g.items)
  const cells = createTexture(gl, gl.RG32UI, CELLS_W, g.cellRows)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CELLS_W, g.cellRows, gl.RG_INTEGER, gl.UNSIGNED_INT, g.table)
  return [items, cells]
}

/**
 * Things boids can see that don't move (flowers, scum, lily pads...), for
 * the GPU: every source's items in one texture, sorted by grid cell, and a
 * table of each cell's [start, end). The item senses of codegen.js read them
 * in one pass (an item is (x, y, id, source)).
 */
export class ItemSources {
  constructor(gl) {
    this.gl = gl
    this.items = null
    this.cells = null
    this.grid = [1, 1]
    this.fineItems = null
    this.fineCells = null
    this.fineGrid = [1, 1]
    this.counts = []
  }

  /** Item texture width (texels). */
  get width() {
    return ITEMS_W
  }

  /** `sources`: per source a Float32Array of (x, y, id) triples; on a `width` x `height` world. */
  set(sources, width, height) {
    const gl = this.gl
    const main = sortByCell(sources, width, height, ITEM_CELL)
    const fine = sortByCell(sources, width, height, FINE_CELL)
    for (const t of [this.items, this.cells, this.fineItems, this.fineCells]) gl.deleteTexture(t)
    ;[this.items, this.cells] = upload(gl, main)
    ;[this.fineItems, this.fineCells] = upload(gl, fine)
    this.grid = main.grid
    this.fineGrid = fine.grid
    this.total = main.total
    this.counts = sources.map((s) => s.length / 3)
  }

  /** The item uniforms codegen.js declares. */
  setUniforms(gl, u) {
    gl.uniform1i(u.u_itemsW, ITEMS_W)
    gl.uniform1i(u.u_itemCellsW, CELLS_W)
    gl.uniform2i(u.u_itemGrid, this.grid[0], this.grid[1])
    gl.uniform1f(u.u_itemCell, ITEM_CELL)
    // The fine grid, for what is right under a boid (only declared where used).
    if (u.u_fineGrid) gl.uniform2i(u.u_fineGrid, this.fineGrid[0], this.fineGrid[1])
    if (u.u_fineCell) gl.uniform1f(u.u_fineCell, FINE_CELL)
  }

  destroy() {
    for (const t of [this.items, this.cells, this.fineItems, this.fineCells]) this.gl.deleteTexture(t)
  }
}
