/**
 * Background "region" map that will later be painted by the user to
 * influence boid behaviour.
 *
 * Design:
 *  - A coarse label grid (Uint8, one byte per cell) stores which region type
 *    covers each cell. 0 = no region.
 *  - A behaviour table maps label -> behaviour parameters. The simulation
 *    samples the label under each boid and applies that behaviour.
 *  - `version` bumps on every change so the renderer re-uploads the texture
 *    only when needed.
 *
 * Nothing paints into it yet; while it is empty `active` is false and the
 * simulation skips sampling entirely, so it costs nothing.
 */

/**
 * @typedef {Object} RegionBehavior
 * @property {string} name
 * @property {[number, number, number, number]} color  RGBA 0-255 used for the background layer
 * @property {number} [speedMultiplier]  scales min/max speed inside the region
 * @property {[number, number]} [flow]   constant steering direction (unit-ish vector)
 * @property {number} [flowWeight]       strength of `flow`, in units of maxForce
 * @property {boolean} [vegetation]      rendered as plants (reeds, cattails)
 */

export class InfluenceField {
  constructor(cellSize = 8) {
    this.cellSize = cellSize
    this.cols = 0
    this.rows = 0
    this.labels = new Uint8Array(0)
    /** @type {(RegionBehavior | null)[]} index = label */
    this.behaviors = [null]
    this.paintedCells = 0
    /** Painted cells whose region has a visible colour. */
    this.colouredCells = 0
    this.version = 0
  }

  get active() {
    return this.paintedCells > 0
  }

  /** 1 if cells with this label are drawn with a visible colour, else 0. */
  isColoured(label) {
    return label && this.behaviors[label]?.color[3] > 0 ? 1 : 0
  }

  /** Whether any painted region shows on screen (e.g. reed beds are invisible). */
  get visible() {
    return this.colouredCells > 0
  }

  resize(width, height) {
    const cols = Math.max(1, Math.ceil(width / this.cellSize))
    const rows = Math.max(1, Math.ceil(height / this.cellSize))
    if (cols === this.cols && rows === this.rows) return

    // Nearest-neighbour resample so painted regions survive window resizes.
    const next = new Uint8Array(cols * rows)
    if (this.labels.length) {
      for (let y = 0; y < rows; y++) {
        const sy = Math.min(this.rows - 1, Math.floor((y * this.rows) / rows))
        for (let x = 0; x < cols; x++) {
          const sx = Math.min(this.cols - 1, Math.floor((x * this.cols) / cols))
          next[y * cols + x] = this.labels[sy * this.cols + sx]
        }
      }
    }
    this.cols = cols
    this.rows = rows
    this.labels = next
    this.recount()
  }

  /** @param {number} id 1-255 @param {RegionBehavior} behavior */
  defineBehavior(id, behavior) {
    this.behaviors[id] = behavior
    this.version++
  }

  labelAt(x, y) {
    const cx = (x / this.cellSize) | 0
    const cy = (y / this.cellSize) | 0
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return 0
    return this.labels[cy * this.cols + cx]
  }

  behaviorAt(x, y) {
    return this.behaviors[this.labelAt(x, y)] ?? null
  }

  /** Paint (or erase with id 0) a disc of world-space radius r. */
  paintCircle(x, y, r, id) {
    const cs = this.cellSize
    const x0 = Math.max(0, Math.floor((x - r) / cs))
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / cs))
    const y0 = Math.max(0, Math.floor((y - r) / cs))
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / cs))
    const r2 = r * r
    for (let cy = y0; cy <= y1; cy++) {
      const dy = (cy + 0.5) * cs - y
      for (let cx = x0; cx <= x1; cx++) {
        const dx = (cx + 0.5) * cs - x
        if (dx * dx + dy * dy > r2) continue
        const k = cy * this.cols + cx
        const prev = this.labels[k]
        if (prev === id) continue
        if (prev === 0) this.paintedCells++
        else if (id === 0) this.paintedCells--
        this.colouredCells += this.isColoured(id) - this.isColoured(prev)
        this.labels[k] = id
      }
    }
    this.version++
  }

  clear() {
    this.labels.fill(0)
    this.paintedCells = 0
    this.colouredCells = 0
    this.version++
  }

  recount() {
    let n = 0
    let coloured = 0
    for (let i = 0; i < this.labels.length; i++) {
      const label = this.labels[i]
      if (!label) continue
      n++
      coloured += this.isColoured(label)
    }
    this.paintedCells = n
    this.colouredCells = coloured
    this.version++
  }

  /**
   * Fill the GPU behaviour table (256 RGBA floats): per label
   * (speedMultiplier, flowX * flowWeight, flowY * flowWeight, 0).
   * Flow is in units of maxForce, applied in the simulation's update pass.
   */
  toBehaviorTable(out) {
    for (let id = 0; id < 256; id++) {
      const b = this.behaviors[id]
      const o = id * 4
      const w = b?.flowWeight ?? 1
      out[o] = b?.speedMultiplier ?? 1
      out[o + 1] = b?.flow ? b.flow[0] * w : 0
      out[o + 2] = b?.flow ? b.flow[1] * w : 0
      out[o + 3] = 0
    }
    return out
  }

  /** Fill an R8 buffer (cols*rows): 255 where the region is vegetation, for rendering plants. */
  toVegetationMask(out) {
    const { labels, behaviors } = this
    for (let i = 0; i < labels.length; i++) out[i] = behaviors[labels[i]]?.vegetation ? 255 : 0
    return out
  }

  /** Fill an RGBA8 buffer (cols*rows*4) for the renderer's background texture. */
  toRGBA(out) {
    const { labels, behaviors } = this
    for (let i = 0; i < labels.length; i++) {
      const b = behaviors[labels[i]]
      const o = i * 4
      if (b) {
        out[o] = b.color[0]
        out[o + 1] = b.color[1]
        out[o + 2] = b.color[2]
        out[o + 3] = b.color[3]
      } else {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
      }
    }
    return out
  }
}
