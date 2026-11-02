/**
 * The focus overlay: what a selected creature senses and the forces on it,
 * as GL_LINES vertices (x, y, premultiplied r, g, b, a) for
 * BoidRenderer.drawLines. Shared by midges, dragonflies and fish, and by the
 * panels' legends (FORCES), so colours match.
 */

/** Forces drawn as arrows from the creature, px of arrow per px/s² (drift: per px/s). */
export const FORCES = [
  { key: 'cohesion', label: 'Cohesion', hex: '#4ade80' },
  { key: 'alignment', label: 'Alignment', hex: '#60a5fa' },
  { key: 'separation', label: 'Separation', hex: '#f87171' },
  { key: 'flowers', label: 'Flowers (by colour)', hex: '#f0abfc' },
  { key: 'scum', label: 'Scum', hex: '#a3e635' },
  { key: 'pads', label: 'Lily pads', hex: '#2dd4bf' },
  { key: 'laying', label: 'Laying (to scum)', hex: '#fb923c' },
  { key: 'propulsion', label: 'Propulsion', hex: '#e879f9' },
  { key: 'seek', label: 'Seek target', hex: '#4ade80' },
  { key: 'spacing', label: 'Spacing', hex: '#f87171' },
  { key: 'evict', label: 'Chased off', hex: '#c084fc' },
  { key: 'wall', label: 'Shore / trunks', hex: '#fde047' },
  { key: 'edge', label: 'Map edge', hex: '#fde047' },
  { key: 'drift', label: 'Wind drift', hex: '#d6d3d1', unit: 'px/s' },
  { key: 'total', label: 'Total', hex: '#ffffff' },
]
const BY_KEY = Object.fromEntries(FORCES.map((f) => [f.key, f]))
const rgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255)
const COLOUR = Object.fromEntries(FORCES.map((f) => [f.key, rgb(f.hex)]))
const ARROW_SCALE = 0.35
const DRIFT_SCALE = 1.5
const ARROW_MAX = 120
/** Lines to what it sees, and rings round seen items (flowers: in their colour as drawn). */
const SEEN = [0.85, 0.9, 0.9]
const SEEN_ALPHA = 0.3
const RING_SEGMENTS = 12
/**
 * How a seen item of each sense (a species' senses, by key) or item source
 * (gpu/PondGpu.js SOURCE) is marked: a faint line to it (its own kind and
 * the like), or a small ring round it in the sense's colour; flower rings
 * (the purple and yellow sources) take the flower's own colour as drawn.
 */
export const SEEN_STYLES = {
  default: { ring: 0 },
  midges: { ring: 0 },
  flowers: { ring: 4, colour: rgb('#f0abfc'), alpha: 0.95 },
  purple: { ring: 4, colour: rgb('#a78bfa'), alpha: 0.95 },
  yellow: { ring: 4, colour: rgb('#facc15'), alpha: 0.95 },
  scum: { ring: 2, colour: rgb('#a3e635'), alpha: 0.7 },
  pads: { ring: 5, colour: rgb('#2dd4bf'), alpha: 0.85 },
}

/** A growing GL_LINES buffer: { data, count, version } as drawLines takes it. */
export class Lines {
  constructor() {
    this.data = new Float32Array(1024)
    this.count = 0
    this.version = 0
  }

  clear() {
    if (this.count) this.version++
    this.count = 0
  }

  line(x0, y0, x1, y1, [r, g, b], a) {
    if ((this.count + 2) * 6 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    const o = this.count * 6
    const d = this.data
    d[o] = x0
    d[o + 1] = y0
    d[o + 6] = x1
    d[o + 7] = y1
    for (const v of [o + 2, o + 8]) {
      d[v] = r * a
      d[v + 1] = g * a
      d[v + 2] = b * a
      d[v + 3] = a
    }
    this.count += 2
  }

  ring(x, y, radius, colour, a, segments = RING_SEGMENTS) {
    for (let k = 0; k < segments; k++) {
      const t0 = (k / segments) * Math.PI * 2
      const t1 = ((k + 1) / segments) * Math.PI * 2
      this.line(x + Math.cos(t0) * radius, y + Math.sin(t0) * radius, x + Math.cos(t1) * radius, y + Math.sin(t1) * radius, colour, a)
    }
  }

  /** Force `key` (vector fx, fy) as an arrow from (x, y): length by its size, clamped; a head of two strokes. */
  arrow(x, y, key, fx, fy) {
    const m = Math.hypot(fx, fy)
    if (m < 1e-6) return
    const len = Math.min(ARROW_MAX, m * (BY_KEY[key].unit ? DRIFT_SCALE : ARROW_SCALE))
    if (len < 1.5) return
    const ux = fx / m
    const uy = fy / m
    const tx = x + ux * len
    const ty = y + uy * len
    const c = COLOUR[key]
    const a = key === 'total' ? 1 : 0.9
    this.line(x, y, tx, ty, c, a)
    const head = Math.min(5, len * 0.4)
    for (const s of [1, -1]) this.line(tx, ty, tx - (ux * 0.85 - uy * 0.5 * s) * head, ty - (uy * 0.85 + ux * 0.5 * s) * head, c, a)
  }

  /** A faint line from (x, y) to something it sees. */
  seen(x, y, sx, sy) {
    this.line(x, y, sx, sy, SEEN, SEEN_ALPHA)
  }

  /** Every force in `forces` ({ key: [fx, fy] }) as arrows from (x, y), the total last (on top). */
  forces(x, y, forces) {
    for (const [key, [fx, fy]] of Object.entries(forces)) if (key !== 'total') this.arrow(x, y, key, fx, fy)
    if (forces.total) this.arrow(x, y, 'total', forces.total[0], forces.total[1])
  }
}
