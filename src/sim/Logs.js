import { PX_PER_METER } from './scale.js'

/** Metres of water per unit of elevation: the deepest floor (0) is 2 m down. */
const METERS_PER_ELEV = 2.5
/** Elevation units per world px, to give a trunk's radius a height. */
export const LOG_ELEV_PER_PX = 1 / (PX_PER_METER * METERS_PER_ELEV)
/** The simulation and the shaders hold at most this many segments. */
export const MAX_LOG_SEGMENTS = 64
/**
 * Segment layout uploaded to the GPU (3 RGBA texels per segment):
 * [ax, ay, bx, by,  ra, rb, za, zb,  seed, length, ends, offset]
 * a/b the ends (px), r the radii (px), z the axis elevation at each end,
 * ends = startEnd + 3 * endEnd (END_*), offset = distance along the whole
 * trunk where this segment starts (so the grain runs on across joints).
 */
export const LOG_STRIDE = 12

/** How a segment end is drawn. */
export const END_HIDDEN = 0 // inside another segment (a branch's base)
export const END_BROKEN = 1 // splintered end of the trunk or a branch
export const END_JOINT = 2 // rounded, overlapping the next segment of a bent trunk
/** Segments per trunk: a few nodes with a little bend between each. */
const TRUNK_NODES = 4
const MAX_BEND = 0.28 // radians either way at each node
/** Furthest the trunk may veer from its overall line, so it never curls into an arc. */
const MAX_VEER = 0.2
/** Share of trunks lying wholly under water (sunk snags) rather than fallen from a bank. */
const SUNKEN_SHARE = 0.3

/** Fallen trunks, in metres. Wetland snags are mostly weathered, pale wood. */
const LENGTH_M = [4, 9]
const RADIUS_M = [0.16, 0.3]
const BRANCH_LENGTH_M = [0.5, 1.5]

/**
 * A straight, rigid segment of a fallen tree (trunk or branch stub). Its axis
 * elevation is linear along the length, so a trunk slopes from the bank down
 * into the water following the floor it rests on.
 */
export class LogSegment {
  constructor(ax, ay, bx, by, ra, rb, za, zb, seed, trunk, startEnd = END_BROKEN, endEnd = END_BROKEN, offset = 0) {
    Object.assign(this, { ax, ay, bx, by, ra, rb, za, zb, seed, trunk, startEnd, endEnd, offset })
    this.length = Math.hypot(bx - ax, by - ay)
  }

  /**
   * Cross-section at (x, y): t along the axis (clamped 0..1), dist from the
   * axis, radius r and axis elevation z there, and the unit vector (nx, ny)
   * from the axis towards the point.
   */
  section(x, y) {
    const dx = this.bx - this.ax
    const dy = this.by - this.ay
    const t = Math.max(0, Math.min(1, ((x - this.ax) * dx + (y - this.ay) * dy) / (dx * dx + dy * dy)))
    const px = x - (this.ax + dx * t)
    const py = y - (this.ay + dy * t)
    const dist = Math.hypot(px, py)
    return {
      t,
      dist,
      r: this.ra + (this.rb - this.ra) * t,
      z: this.za + (this.zb - this.za) * t,
      nx: dist > 1e-6 ? px / dist : -dy / this.length,
      ny: dist > 1e-6 ? py / dist : dx / this.length,
    }
  }

  /** Half-width of the part of the cross-section above `level` (0 = fully under). */
  emergentHalfWidth(r, z, level) {
    const re = r * LOG_ELEV_PER_PX
    if (z + re <= level) return 0
    if (z >= level) return r
    const k = (level - z) / re
    return r * Math.sqrt(1 - k * k)
  }

  /** Bounding box grown by `margin` px. */
  bounds(margin) {
    const r = Math.max(this.ra, this.rb) + margin
    return [Math.min(this.ax, this.bx) - r, Math.min(this.ay, this.by) - r, Math.max(this.ax, this.bx) + r, Math.max(this.ay, this.by) + r]
  }
}

/**
 * Trees fallen from the banks: each trunk's root end lies on land near the
 * shore and the trunk reaches out into the water (some stay on land); about a
 * third are sunken snags lying wholly in the water. A trunk
 * is a few nodes with a little bend between each, drawn as one piece. It
 * rests rigidly on the highest points of the floor beneath it, so it may sink
 * into deep water at an angle, or bridge a dip with water below it.
 * @param {import('./PondMap.js').PondMap} map
 */
export function generateLogs(map, rand, count, landLevel) {
  const logs = []
  const [vx, vy, vw, vh] = map.view ?? [0, 0, map.width, map.height]
  const inset = 30
  const inBounds = (x, y) => x > 10 && y > 10 && x < map.width - 10 && y < map.height - 10
  // Each trunk's kind is chosen up front: sunken spots are far easier to find
  // than bank ones, so choosing per attempt would make nearly all sunken.
  let sunken = rand() < SUNKEN_SHARE
  for (let tries = 0, placed = 0, kindTries = 0; placed < count && tries < count * 1000; tries++, kindTries++) {
    if (kindTries > 600) {
      sunken = !sunken // no room for this kind: try the other
      kindTries = 0
    }
    if (logs.length + TRUNK_NODES + 2 > MAX_LOG_SEGMENTS) break
    // Roots may be on the banks just off screen, as long as the trunk reaches into view.
    const x = 10 + rand() * (map.width - 20)
    const y = 10 + rand() * (map.height - 20)
    const d = map.distanceAt(x, y)
    // Most fell from a bank (root end on land, near the water); some are old
    // snags lying wholly on the pond floor.
    if (sunken ? d < 12 : d > -4 || d < -60) continue
    const [gx, gy] = map.gradientAt(x, y)
    const intoWater = !sunken && rand() < 0.8
    const heading = intoWater ? Math.atan2(gy, gx) + (rand() - 0.5) * 1.4 : rand() * Math.PI * 2
    const len = (LENGTH_M[0] + rand() * (LENGTH_M[1] - LENGTH_M[0])) * PX_PER_METER
    const r0 = (RADIUS_M[0] + rand() * (RADIUS_M[1] - RADIUS_M[0])) * PX_PER_METER
    const r1 = r0 * (0.45 + rand() * 0.2)
    // Nodes along a gently wandering path: each bend is random, but the
    // heading stays within MAX_VEER of the trunk's line, so bends that keep
    // going one way are turned back and the trunk reads as straight overall.
    const nodes = [[x, y]]
    const step = len / TRUNK_NODES
    let veer = (rand() - 0.5) * MAX_VEER
    for (let k = 0; k < TRUNK_NODES; k++) {
      if (k > 0) {
        let bend = (0.4 + 0.6 * rand()) * MAX_BEND * (rand() < 0.5 ? -1 : 1)
        if (Math.abs(veer + bend) > MAX_VEER) bend = -bend
        veer = Math.max(-MAX_VEER, Math.min(MAX_VEER, veer + bend))
      }
      const [px, py] = nodes[k]
      nodes.push([px + Math.cos(heading + veer) * step, py + Math.sin(heading + veer) * step])
    }
    const [tx, ty] = nodes[TRUNK_NODES]
    if (!nodes.every(([nx, ny]) => inBounds(nx, ny))) continue
    if (!nodes.slice(1).some(([nx, ny]) => nx > vx + inset && ny > vy + inset && nx < vx + vw - inset && ny < vy + vh - inset)) continue
    if (intoWater && map.distanceAt(tx, ty) < 8) continue
    if (sunken && nodes.some(([nx, ny]) => map.distanceAt(nx, ny) < 6)) continue
    if (nodes.slice(1).some(([nx, ny], k) => crossesOthers(logs, nodes[k][0], nodes[k][1], nx, ny, r0))) continue
    const radiusAt = (f) => r0 + (r1 - r0) * f
    const zAt = restingLine(map, nodes, radiusAt)
    const seed = rand()
    for (let k = 0; k < TRUNK_NODES; k++) {
      const f0 = k / TRUNK_NODES
      const f1 = (k + 1) / TRUNK_NODES
      const [ax, ay] = nodes[k]
      const [bx, by] = nodes[k + 1]
      logs.push(new LogSegment(ax, ay, bx, by, radiusAt(f0), radiusAt(f1), zAt(f0), zAt(f1), seed, true,
        k === 0 ? END_BROKEN : END_JOINT, k === TRUNK_NODES - 1 ? END_BROKEN : END_JOINT, f0 * len))
    }
    placed++
    sunken = rand() < SUNKEN_SHARE
    kindTries = 0

    // A couple of broken-off branch stubs.
    const branches = Math.floor(rand() * 3)
    for (let b = 0; b < branches; b++) {
      const f = 0.35 + rand() * 0.55
      const k = Math.min(TRUNK_NODES - 1, Math.floor(f * TRUNK_NODES))
      const local = f * TRUNK_NODES - k
      const [ax, ay] = nodes[k]
      const [bx, by] = nodes[k + 1]
      const sx = ax + (bx - ax) * local
      const sy = ay + (by - ay) * local
      const side = rand() < 0.5 ? -1 : 1
      const ba = Math.atan2(by - ay, bx - ax) + side * (0.5 + rand() * 0.6)
      const bl = (BRANCH_LENGTH_M[0] + rand() * (BRANCH_LENGTH_M[1] - BRANCH_LENGTH_M[0])) * PX_PER_METER
      const rb0 = Math.max(2, radiusAt(f) * (0.35 + rand() * 0.15))
      const ex = sx + Math.cos(ba) * bl
      const ey = sy + Math.sin(ba) * bl
      const z0 = zAt(f)
      const ground = Math.min(map.elevationAt(ex, ey), landLevel + 0.2) + rb0 * 0.6 * LOG_ELEV_PER_PX
      const z1 = Math.max(z0 - 0.08, Math.min(z0 + 0.02, ground))
      logs.push(new LogSegment(sx, sy, ex, ey, rb0, rb0 * 0.6, z0, z1, seed, false, END_HIDDEN, END_BROKEN, f * len))
    }
  }
  return logs
}

/** Whether a new trunk segment would cross or touch one already placed. */
function crossesOthers(logs, ax, ay, bx, by, r) {
  for (let k = 0; k <= 8; k++) {
    const x = ax + ((bx - ax) * k) / 8
    const y = ay + ((by - ay) * k) / 8
    for (const log of logs) {
      const s = log.section(x, y)
      if (s.dist < s.r + r + 8) return true
    }
  }
  return false
}

/**
 * Axis elevation of a rigid trunk lying on the floor, as a function of the
 * fraction f of its length: the lowest straight line (in f) that stays above
 * floor + radius everywhere along it (it rests on the two points that hold it
 * up). `nodes` is the trunk's path, equal-length steps.
 */
function restingLine(map, nodes, radiusAt) {
  const N = 32
  const steps = nodes.length - 1
  const t = []
  const h = []
  for (let i = 0; i <= N; i++) {
    const f = i / N
    const k = Math.min(steps - 1, Math.floor(f * steps))
    const local = f * steps - k
    const [ax, ay] = nodes[k]
    const [bx, by] = nodes[k + 1]
    t.push(f)
    h.push(map.elevationAt(ax + (bx - ax) * local, ay + (by - ay) * local) + radiusAt(f) * LOG_ELEV_PER_PX)
  }
  let best = null
  let bestSum = Infinity
  for (let i = 0; i <= N; i++) {
    for (let j = i + 1; j <= N; j++) {
      const slope = (h[j] - h[i]) / (t[j] - t[i])
      const at = (k) => h[i] + slope * (t[k] - t[i])
      let ok = true
      let sum = 0
      for (let k = 0; k <= N && ok; k++) {
        if (at(k) < h[k] - 1e-6) ok = false
        sum += at(k)
      }
      if (ok && sum < bestSum) {
        bestSum = sum
        best = [at(0), slope]
      }
    }
  }
  const [z0, slope] = best ?? [h[0], h[N] - h[0]]
  return (f) => z0 + slope * f
}

/** Pack segments for the GPU (LOG_STRIDE floats each). */
export function packLogs(logs) {
  const data = new Float32Array(Math.max(1, logs.length) * LOG_STRIDE)
  logs.forEach((l, i) => data.set([l.ax, l.ay, l.bx, l.by, l.ra, l.rb, l.za, l.zb, l.seed, l.length, l.startEnd + 3 * l.endEnd, l.offset], i * LOG_STRIDE))
  return data
}
