import { createTexture } from '../gl.js'

/** Grid cell for items (px). */
export const ITEM_CELL = 64
const ITEMS_W = 1024
const CELLS_W = 256

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
    this.counts = []
  }

  /** Item texture width (texels). */
  get width() {
    return ITEMS_W
  }

  /** `sources`: per source a Float32Array of (x, y, id) triples; on a `width` x `height` world. */
  set(sources, width, height) {
    const gl = this.gl
    const gw = Math.max(1, Math.ceil(width / ITEM_CELL))
    const gh = Math.max(1, Math.ceil(height / ITEM_CELL))
    const cells = gw * gh
    const total = sources.reduce((n, s) => n + s.length / 3, 0)
    // Counting sort by cell.
    const start = new Uint32Array(cells + 1)
    const keyOf = []
    sources.forEach((pts) => {
      for (let i = 0; i < pts.length; i += 3) {
        const cx = Math.min(gw - 1, Math.max(0, Math.floor(pts[i] / ITEM_CELL)))
        const cy = Math.min(gh - 1, Math.max(0, Math.floor(pts[i + 1] / ITEM_CELL)))
        const key = cy * gw + cx
        keyOf.push(key)
        start[key + 1]++
      }
    })
    for (let k = 0; k < cells; k++) start[k + 1] += start[k]
    const fill = start.slice(0, cells)
    const rows = Math.max(1, Math.ceil(total / ITEMS_W))
    const items = new Float32Array(ITEMS_W * rows * 4)
    let n = 0
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
    gl.deleteTexture(this.items)
    gl.deleteTexture(this.cells)
    this.items = createTexture(gl, gl.RGBA32F, ITEMS_W, rows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ITEMS_W, rows, gl.RGBA, gl.FLOAT, items)
    this.cells = createTexture(gl, gl.RG32UI, CELLS_W, cellRows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CELLS_W, cellRows, gl.RG_INTEGER, gl.UNSIGNED_INT, table)
    this.grid = [gw, gh]
    this.total = total
    this.counts = sources.map((s) => s.length / 3)
  }

  /** The item uniforms codegen.js declares. */
  setUniforms(gl, u) {
    gl.uniform1i(u.u_itemsW, ITEMS_W)
    gl.uniform1i(u.u_itemCellsW, CELLS_W)
    gl.uniform2i(u.u_itemGrid, this.grid[0], this.grid[1])
    gl.uniform1f(u.u_itemCell, ITEM_CELL)
  }

  destroy() {
    this.gl.deleteTexture(this.items)
    this.gl.deleteTexture(this.cells)
  }
}
