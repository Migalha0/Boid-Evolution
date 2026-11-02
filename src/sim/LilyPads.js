import { PX_PER_METER } from './scale.js'

/** Instance layout uploaded to the GPU: [x, y, radius, angle, seed, flower (FLOWER), variety (VARIETY), 0]. */
export const PAD_STRIDE = 8
/** Real water lily pads are ~16–30 cm across. */
const RADIUS_M = [0.08, 0.15]
/** Lilies root in fairly shallow water but not inside the reed beds. */
const SHALLOW_RANGE = [0.15, 0.6]
/** What a pad carries: nothing, an open bloom, or a closed bud. */
export const FLOWER = { none: 0, open: 1, bud: 2 }
/** A colony's lily variety (one per colony, as a clone spreads): pink, white, yellow. */
export const VARIETY = { pink: 0, white: 1, yellow: 2 }

/**
 * Water lily colonies. Pads are anchored by their stems, so they don't drift:
 * the GPU bobs them in place and pushes them with the same sway field that
 * bends the reeds. Static instance data, regenerated with the map.
 */
export class LilyPads {
  /** @param {import('./PondMap.js').PondMap} map */
  constructor(map) {
    this.map = map
    this.count = 0
    this.data = new Float32Array(0)
    this.version = -1
    /** How many colonies grow: 0 none, 1 as generated (a few per screen), 3 three times as many. */
    this.amount = 1
  }

  sync() {
    if (this.version !== this.key) this.generate()
  }

  /** Pads are laid out again with a new map, new trunks or a new amount. */
  get key() {
    return `${this.map.version}|${this.map.logVersion}|${this.amount}`
  }

  inReeds(x, y) {
    return this.map.inReeds(x, y)
  }

  generate() {
    const map = this.map
    const { width: W, height: H } = map
    const pads = []
    // Uniform grid for overlap tests: cell >= largest pad diameter.
    const CELL = Math.ceil(RADIUS_M[1] * PX_PER_METER * 2)
    const cols = Math.ceil(W / CELL)
    const grid = new Map()
    const overlaps = (x, y, r) => {
      const cx = Math.floor(x / CELL)
      const cy = Math.floor(y / CELL)
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (let i = cx - 1; i <= cx + 1; i++) {
          for (const p of grid.get(j * cols + i) ?? []) {
            if (Math.hypot(p[0] - x, p[1] - y) < p[2] + r + 0.5) return true
          }
        }
      }
      return false
    }

    const colonies = Math.round(Math.max(4, Math.min(14, Math.round((W * H) / 110000))) * this.amount)
    for (let c = 0; c < colonies; c++) {
      let cx = 0
      let cy = 0
      for (let attempt = 0; attempt < 40; attempt++) {
        ;[cx, cy] = map.randomPoint(30)
        const s = map.shallowness(cx, cy)
        if (s >= SHALLOW_RANGE[0] && s <= SHALLOW_RANGE[1] && !this.inReeds(cx, cy)) break
      }
      const v = Math.random()
      const variety = v < 0.5 ? VARIETY.pink : v < 0.85 ? VARIETY.white : VARIETY.yellow
      const spread = 25 + Math.random() * 50
      const target = 25 + Math.floor(Math.random() * 50)
      let placed = 0
      for (let attempt = 0; attempt < target * 6 && placed < target; attempt++) {
        const r = (RADIUS_M[0] + Math.random() * (RADIUS_M[1] - RADIUS_M[0])) * PX_PER_METER
        const a = Math.random() * Math.PI * 2
        const d = spread * Math.sqrt(Math.random())
        const x = cx + Math.cos(a) * d
        const y = cy + Math.sin(a) * d
        if (map.surfaceDistanceAt(x, y) < r + 2 || map.insideView(x, y) < r || this.inReeds(x, y) || overlaps(x, y, r)) continue
        const pad = [x, y, r]
        const key = Math.floor(y / CELL) * cols + Math.floor(x / CELL)
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key).push(pad)
        const f = Math.random()
        pads.push([x, y, r, Math.random() * Math.PI * 2, Math.random(), f < 0.1 ? FLOWER.open : f < 0.18 ? FLOWER.bud : FLOWER.none, variety])
        placed++
      }
    }

    this.data = new Float32Array(pads.length * PAD_STRIDE)
    pads.forEach((p, i) => this.data.set(p, i * PAD_STRIDE))
    this.count = pads.length
    this.version = this.key
  }
}
