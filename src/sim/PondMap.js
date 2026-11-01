import { generateLogs } from './Logs.js'
import { PLANT, PLANT_KINDS, Vegetation } from './Vegetation.js'

/** World px per elevation sample. */
export const ELEV_CELL = 6
/** World px per signed-distance sample. */
export const SDF_CELL = 3
/** Elevation above which the floor breaks the surface and becomes land. */
export const LAND_LEVEL = 0.8
/** Elevation where aquatic vegetation starts to appear. */
const VEG_START = 0.5
/**
 * Even where the shallows are planted, plants in the water stand this far
 * apart (as a share of the land's cover), so water shows between them; only
 * a narrow fringe along the bank grows thick, so the bank's edge never shows.
 */
const WATER_COVER = 0.45
/** Field label for reed beds in the water (behaviour hook, neutral for now). */
export const REEDS = 1

/**
 * The pond map, generated from a seed (resizing regenerates the same map).
 *
 *  - elevation: topographic map of the floor, 0 = deepest, 1 = highest.
 *    Banks along the canvas border are raised with a noisy width, so the
 *    shoreline is irregular even though the canvas is a rectangle.
 *  - land: everything above LAND_LEVEL (banks + islands).
 *  - sdf: signed distance to the shore in px (+ water, - land), exact via a
 *    Euclidean distance transform. Used for boid steering/containment and for
 *    rendering the shoreline.
 *  - logs: fallen tree trunks (see Logs.js), resting on the floor from the
 *    banks out into the water.
 *  - surfaceSdf: like sdf, but for things floating on the surface: the parts of
 *    the trunks that break the surface count as land.
 *  - vegetation: plants growing out from the land and shallows; the shallower
 *    and closer to shore, the denser. Land is heavily overgrown. Plants next to
 *    a trunk grow away from it (on land only partly, see landClearing).
 */
export class PondMap {
  constructor(field) {
    this.field = field
    this.vegetation = new Vegetation()
    this.seed = newSeed()
    this.width = 0
    this.height = 0
    /** Visible part of the map [x, y, w, h]; spawning prefers it. */
    this.view = null
    this.version = 0
    /** 0..1, how much the deep edge of the plant zone is thinned. */
    this.sparseness = 0.6
    /** 0..1, share of the shallowest water and shore fringe that is planted; the rest opens up in gaps. */
    this.shallowDensity = 0.5
    /** Number of fallen trunks. */
    this.logCount = 4
    this.logs = []
    /** Changed to lay the trunks somewhere else on the same map. */
    this.logShuffle = 0
    /** 0..1, how far land plants make way for a trunk (water plants always do). */
    this.landClearing = 0.3
    /** Bumped whenever the logs (and so the plants around them) change. */
    this.logVersion = 0
    /** How much of each plant kind grows (by PLANT index): 0 = none, 1 = as generated, 2 = twice as many. */
    this.kindAmounts = PLANT_KINDS.map(() => 1)
  }

  layout(width, height) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.generate()
  }

  newMap() {
    this.seed = newSeed()
    this.generate()
  }

  generate() {
    const rand = mulberry32(this.seed)
    this.generateElevation(rand)
    this.generateSdf()
    this.generateLogs()
    this.generateVegetation()
    this.version++
  }

  /** Regrow the plants alone (same floor and shore), e.g. after a sparseness change. */
  regrowPlants() {
    if (this.width) this.generateVegetation()
  }

  /** Lay the trunks again (same floor and shore), e.g. after a count change; plants follow. */
  relayLogs() {
    if (!this.width) return
    this.generateLogs()
    this.generateVegetation()
  }

  /** New trunk placement on the same map. */
  shuffleLogs() {
    this.logShuffle = (Math.random() * 2 ** 31) | 0
    this.relayLogs()
  }

  generateLogs() {
    // Own random stream: the same trunks for the same map, count and shuffle.
    this.logs = generateLogs(this, mulberry32(this.seed ^ 0x27d4eb2f ^ this.logShuffle), this.logCount, LAND_LEVEL)
    // Surface SDF: the shore SDF, cut wherever a trunk breaks the surface.
    const surface = this.sdf.slice()
    const sc = this.sdfCols
    for (const log of this.logs) {
      const [x0, y0, x1, y1] = log.bounds(SDF_CELL * 4)
      for (let j = Math.max(0, Math.floor(y0 / SDF_CELL)); j < Math.min(this.sdfRows, Math.ceil(y1 / SDF_CELL)); j++) {
        for (let i = Math.max(0, Math.floor(x0 / SDF_CELL)); i < Math.min(sc, Math.ceil(x1 / SDF_CELL)); i++) {
          const s = log.section((i + 0.5) * SDF_CELL, (j + 0.5) * SDF_CELL)
          const half = log.emergentHalfWidth(s.r, s.z, LAND_LEVEL)
          if (half > 0) surface[j * sc + i] = Math.min(surface[j * sc + i], s.dist - half)
        }
      }
    }
    this.surfaceSdf = surface
    this.logVersion++
  }

  /**
   * Nearest trunk side to (x, y) within `margin` px: { gap, nx, ny } with gap
   * the distance from the trunk's surface (< 0 under it) and (nx, ny) pointing
   * away from it; null if none is that close.
   */
  logClearance(x, y, margin) {
    let best = null
    for (const log of this.logs) {
      const [x0, y0, x1, y1] = log.bounds(margin)
      if (x < x0 || y < y0 || x > x1 || y > y1) continue
      const s = log.section(x, y)
      const gap = s.dist - s.r
      if (gap < margin && (!best || gap < best.gap)) best = { gap, nx: s.nx, ny: s.ny }
    }
    return best
  }

  generateElevation(rand) {
    const noise = makeNoise(rand)
    const W = this.width
    const H = this.height
    const cols = Math.ceil(W / ELEV_CELL) + 1
    const rows = Math.ceil(H / ELEV_CELL) + 1
    const e = new Float32Array(cols * rows)
    const scale = 1 / (220 + rand() * 160) // feature size in px
    let min = Infinity
    let max = -Infinity
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = i * ELEV_CELL * scale
        const y = j * ELEV_CELL * scale
        // Domain warping gives ridges and basins rather than plain blobs.
        const qx = fbm(noise, x, y)
        const qy = fbm(noise, x + 5.2, y + 1.3)
        const v = fbm(noise, x + 1.6 * qx, y + 1.6 * qy)
        e[j * cols + i] = v
        min = Math.min(min, v)
        max = Math.max(max, v)
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        const x = Math.min(W, i * ELEV_CELL)
        const y = Math.min(H, j * ELEV_CELL)
        // Raised banks along the border, with a noisy width -> squiggly shore.
        const edge = Math.min(x, y, W - x, H - y)
        const bank = 2 + 17 * smoothstep(0.3, 0.7, fbm(noise, x * 0.012 + 31.7, y * 0.012 + 11.3))
        e[k] = Math.min(1, (e[k] - min) / (max - min || 1) + 0.95 * (1 - smoothstep(0, bank, edge)))
      }
    }
    this.cols = cols
    this.rows = rows
    this.elevation = e
  }

  generateSdf() {
    const sc = Math.ceil(this.width / SDF_CELL)
    const sr = Math.ceil(this.height / SDF_CELL)
    const n = sc * sr
    const land = new Uint8Array(n)
    for (let j = 0; j < sr; j++) {
      for (let i = 0; i < sc; i++) {
        const border = i === 0 || j === 0 || i === sc - 1 || j === sr - 1
        land[j * sc + i] = border || this.elevationAt((i + 0.5) * SDF_CELL, (j + 0.5) * SDF_CELL) > LAND_LEVEL ? 1 : 0
      }
    }
    fillEnclosedWater(land, sc, sr)
    const toLand = edt(land, sc, sr, 1)
    const toWater = edt(land, sc, sr, 0)
    const sdf = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      sdf[k] = land[k] ? -(Math.sqrt(toWater[k]) - 0.5) * SDF_CELL : (Math.sqrt(toLand[k]) - 0.5) * SDF_CELL
    }
    this.sdfCols = sc
    this.sdfRows = sr
    this.sdf = sdf
  }

  generateVegetation() {
    // Its own random stream, so regrowing reproduces the same layout.
    const rand = mulberry32(this.seed ^ 0x5bd1e995)
    const noise = makeNoise(rand)
    const veg = this.vegetation
    veg.clear()
    const G = 4 // jittered grid spacing in px
    // Reeds lean along a smooth direction field, so neighbours point alike.
    const flow = (x, y) => Math.PI * 4 * fbm(noise, x * 0.004 + 50.3, y * 0.004 + 7.9)
    const rotation = (x, y) => flow(x, y) + (rand() - 0.5) * 0.5
    // Colour regions: broad patches of dry brown and yellow-green within the
    // green, blending smoothly, plus a little per-plant jitter.
    const tones = makeNoise(rand)
    const jitter = (v) => Math.max(0, Math.min(1, v + (rand() - 0.5) * 0.2))
    const brown = (x, y) => jitter(smoothstep(0.48, 0.66, fbm(tones, x * 0.0035, y * 0.0035)))
    const yellow = (x, y) => jitter(smoothstep(0.48, 0.66, fbm(tones, x * 0.0035 + 91.7, y * 0.0035 + 23.1)))
    const claimAt = this.makeClaims(rand, noise)
    // Open water in the shallows: irregular gaps where a noise field is below
    // the level that leaves shallowDensity of the area planted (the noise is
    // about normal, mean 0.525, sd 0.12; logistic approximation of its quantile).
    const planted = Math.min(Math.max(this.shallowDensity, 1e-3), 1 - 1e-3)
    const gapLevel = 0.525 + (0.12 * Math.log((1 - planted) / planted)) / 1.7
    // Gaps keep off the shore itself: a fringe stays planted so the bank's
    // edge never shows.
    const unGapped = (x, y, d) => {
      if (this.shallowDensity >= 1) return 1
      const fringe = 1 - smoothstep(12, 40, d)
      return Math.max(fringe, smoothstep(gapLevel - 0.03, gapLevel + 0.03, fbm(noise, x * 0.009 + 311.7, y * 0.009 + 87.3)))
    }
    // Trunks lie where they fell. In the water nothing grows under one, and
    // plants beside it are bent away from it (and kept short enough), so the
    // trunk shows. On land (drawn over the plants anyway) they only make way
    // by landClearing, so the ground stays covered.
    const reachMax = Math.max(...PLANT_KINDS.map((k) => k.length[1])) * 1.4
    // Ground a plant of each kind covers seen from above (its blades and head).
    const COVER = PLANT_KINDS.map((k) => k.blades * ((k.length[0] + k.length[1]) / 2) * k.width + (k.head ? k.head.length * k.head.width : 0))
    // What grows where: [kind, share] per habitat, picked in this order.
    const LAND = [[PLANT.SHRUB, 0.4], [PLANT.REED, 0.25], [PLANT.CATTAIL, 0.2], [PLANT.IRIS, 0.05], [PLANT.RUSH, 0.1]]
    const SHALLOW = [[PLANT.CATTAIL, 0.33], [PLANT.REED, 0.37], [PLANT.IRIS, 0.11], [PLANT.PICKERELWEED, 0.09], [PLANT.RUSH, 0.1]]
    // Pickerelweed favours the middle shallows.
    const MIDDLE = [[PLANT.REED, 0.42], [PLANT.RUSH, 0.32], [PLANT.PICKERELWEED, 0.16], [PLANT.CATTAIL, 0.06], [PLANT.IRIS, 0.04]]
    const pick = (mix, r) => {
      for (const [kind, share] of mix) if ((r -= share) < 0) return kind
      return mix[mix.length - 1][0]
    }
    // In place of a kind there is less of: another from the spot's mix, by
    // their amounts, so its stands don't leave the floor bare. -1 if none grows.
    const substitute = (kind, mix) => {
      let total = 0
      for (const [k, share] of mix) if (k !== kind) total += share * (this.kindAmounts[k] ?? 1)
      if (total <= 0) return -1
      let r = rand() * total
      for (const [k, share] of mix) if (k !== kind && (r -= share * (this.kindAmounts[k] ?? 1)) < 0) return k
      return -1
    }
    // Each kind grows as often as its amount says: below 1 the rest of its
    // plants are swapped for others from `mix` (as many as cover the same
    // ground: a cattail's place takes about three rushes), above 1 a fraction
    // is a chance of one more; at whole amounts the layout doesn't change.
    const add = (kind, x, y, scale, rot, seed, br, ye, land, mix) => {
      const amount = this.kindAmounts[kind] ?? 1
      if (amount < 1 && rand() >= amount) {
        const sub = substitute(kind, mix)
        if (sub < 0) return
        const ratio = COVER[kind] / COVER[sub]
        const n = Math.max(1, Math.floor(ratio) + (rand() < ratio % 1 ? 1 : 0))
        // Spread over the ground the missing plant would have covered.
        const spread = Math.min(PLANT_KINDS[kind].length[1] * scale * 0.5, G * 2)
        place(sub, x, y, scale, rot, seed, br, ye, land)
        for (let c = 1; c < n; c++) {
          place(sub, x + (rand() - 0.5) * 2 * spread, y + (rand() - 0.5) * 2 * spread, scale * (0.85 + rand() * 0.3), rotation(x, y), rand(), br, ye, land)
        }
        return
      }
      const frac = amount - Math.floor(amount)
      const copies = Math.max(1, Math.floor(amount) + (amount > 1 && frac > 0 && rand() < frac ? 1 : 0))
      for (let c = 0; c < copies; c++) {
        if (c === 0) place(kind, x, y, scale, rot, seed, br, ye, land)
        else place(kind, x + (rand() - 0.5) * G, y + (rand() - 0.5) * G, scale * (0.85 + rand() * 0.3), rot + (rand() - 0.5) * 0.6, rand(), br, ye, land)
      }
    }
    const place = (kind, x, y, scale, rot, seed, br, ye, land) => {
      const near = this.logs.length ? this.logClearance(x, y, reachMax) : null
      const clear = land ? this.landClearing : 1
      if (near && clear > 0) {
        if (!land && near.gap < 1.5) return
        const k = PLANT_KINDS[kind]
        const reach = k.length[1] * scale
        if (reach > near.gap) {
          const away = Math.atan2(near.ny, near.nx) + (rand() - 0.5) * 0.5
          // Shortest turn towards facing away, by `clear`.
          const turn = Math.atan2(Math.sin(away - rot), Math.cos(away - rot))
          rot += turn * clear
          // Blades fan out by up to spread / 2 to either side of the rotation.
          const forward = Math.max(0.25, Math.cos(Math.min(Math.PI, k.spread / 2)))
          const fits = Math.max(0, near.gap) / k.length[1] / forward
          scale = Math.min(scale, scale + (fits - scale) * clear)
          if (scale < 0.3) {
            if (!land) return
            scale = 0.3
          }
        }
      }
      veg.add(kind, x, y, scale, rot, seed, br, ye, land)
    }
    for (let gy = 0; gy * G < this.height; gy++) {
      for (let gx = 0; gx * G < this.width; gx++) {
        const x = (gx + rand()) * G
        const y = (gy + rand()) * G
        const d = this.distanceAt(x, y)
        const patch = 0.55 + 0.6 * fbm(noise, x * 0.02, y * 0.02) // clumpy, never uniform
        if (d < 0) {
          // Land: heavily overgrown.
          if (rand() > 0.9 * patch) continue
          const r = rand()
          const kind = claimAt(x, y) ?? pick(LAND, r)
          add(kind, x, y, 1 + rand() * 0.35, rotation(x, y), rand(), brown(x, y), yellow(x, y), true, LAND)
          continue
        }
        const shallow = this.shallowness(x, y, d)
        // Towards the deep edge of the plant zone growth thins out, so open
        // water reads as water; the shallowest water and shore fringes, lush
        // otherwise, open up in gaps.
        const lush = smoothstep(0.45, 0.9, shallow)
        const thin = (1 - this.sparseness * (1 - lush)) * (1 - lush + lush * unGapped(x, y, d))
        const fringe = 1 - smoothstep(4, 16, d)
        const cover = 1 - lush * (1 - fringe) * (1 - WATER_COVER)
        if (rand() > Math.min(1, shallow ** 1.4 * 1.2 * patch) * thin * cover) continue
        const r = rand()
        // The deep edge grows only rush, but takes from the middle mix in its place.
        const mix = shallow > 0.7 ? SHALLOW : MIDDLE
        const kind = claimAt(x, y) ?? (shallow > 0.35 ? pick(mix, r) : PLANT.RUSH)
        add(kind, x, y, 0.75 + shallow * 0.4 + rand() * 0.2, rotation(x, y), rand(), brown(x, y), yellow(x, y), false, mix)
      }
    }

    // Reed beds as a region type, so behaviours can be attached later.
    const field = this.field
    field.clear()
    field.defineBehavior(REEDS, { name: 'reeds', vegetation: true, color: [0, 0, 0, 0] })
    const cs = field.cellSize
    for (let j = 0; j < field.rows; j++) {
      for (let i = 0; i < field.cols; i++) {
        const x = (i + 0.5) * cs
        const y = (j + 0.5) * cs
        const d = this.distanceAt(x, y)
        field.labels[j * field.cols + i] = d >= 0 && this.shallowness(x, y, d) > 0.45 ? REEDS : 0
      }
    }
    field.recount()
  }

  /**
   * Stands claimed by a single kind (cattail, reed or iris): irregular blobs
   * placed in vegetated spots. Returns claimAt(x, y) -> kind | null; inside a
   * stand nearly every plant is its kind, fading to the normal mix at the edge.
   */
  makeClaims(rand, noise) {
    const claims = []
    const target = Math.round((this.width * this.height) / 45000)
    for (let c = 0; c < target; c++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const x = rand() * this.width
        const y = rand() * this.height
        const d = this.distanceAt(x, y)
        if (d < -30 || (d >= 0 && this.shallowness(x, y, d) < 0.35)) continue
        const r = rand()
        const kind = r < 0.35 ? PLANT.CATTAIL : r < 0.65 ? PLANT.REED : r < 0.85 ? PLANT.IRIS : PLANT.PICKERELWEED
        const radius = kind === PLANT.IRIS || kind === PLANT.PICKERELWEED ? 25 + rand() * 35 : 40 + rand() * 70
        claims.push({ x, y, radius, kind })
        break
      }
    }
    return (x, y) => {
      let best = 0
      let kind = null
      for (const c of claims) {
        const dx = x - c.x
        const dy = y - c.y
        if (Math.abs(dx) > c.radius * 1.3 || Math.abs(dy) > c.radius * 1.3) continue
        // Noise-warped distance -> irregular outline.
        const dist = (Math.hypot(dx, dy) / c.radius) * (0.75 + 0.5 * noise(x * 0.03 + 40, y * 0.03 + 40))
        const strength = 1 - smoothstep(0.7, 1.05, dist)
        if (strength > best) {
          best = strength
          kind = c.kind
        }
      }
      return rand() < best * 0.95 ? kind : null
    }
  }

  /** 0..1, how vegetated a water spot is: shallow floor or close to shore. */
  shallowness(x, y, d = this.distanceAt(x, y)) {
    return Math.max(smoothstep(VEG_START, LAND_LEVEL, this.elevationAt(x, y)), 1 - smoothstep(0, 45, d))
  }

  /** Bilinear elevation at a world position. */
  elevationAt(x, y) {
    return bilinear(this.elevation, this.cols, this.rows, x / ELEV_CELL, y / ELEV_CELL)
  }

  /** Like distanceAt, for things on the surface: trunks breaking the surface count as land. */
  surfaceDistanceAt(x, y) {
    return bilinear(this.surfaceSdf, this.sdfCols, this.sdfRows, x / SDF_CELL - 0.5, y / SDF_CELL - 0.5)
  }

  /** Signed distance to the shore in px: + in water, - on land. */
  distanceAt(x, y) {
    return bilinear(this.sdf, this.sdfCols, this.sdfRows, x / SDF_CELL - 0.5, y / SDF_CELL - 0.5)
  }

  /** Direction of increasing distance from shore (unnormalised). */
  gradientAt(x, y) {
    const h = SDF_CELL
    return [this.distanceAt(x + h, y) - this.distanceAt(x - h, y), this.distanceAt(x, y + h) - this.distanceAt(x, y - h)]
  }

  /** Random point in open water at least `margin` px from the shore, inside the view if set. */
  randomPoint(margin = 20) {
    const [vx, vy, vw, vh] = this.view ?? [0, 0, this.width, this.height]
    for (let i = 0; i < 1000; i++) {
      const x = vx + Math.random() * vw
      const y = vy + Math.random() * vh
      if (this.distanceAt(x, y) > margin) return [x, y]
    }
    return [this.width / 2, this.height / 2]
  }
}

function bilinear(grid, cols, rows, fx, fy) {
  fx = Math.max(0, Math.min(cols - 1, fx))
  fy = Math.max(0, Math.min(rows - 1, fy))
  const i = Math.min(cols - 2, Math.floor(fx))
  const j = Math.min(rows - 2, Math.floor(fy))
  const tx = fx - i
  const ty = fy - j
  const a = grid[j * cols + i] * (1 - tx) + grid[j * cols + i + 1] * tx
  const b = grid[(j + 1) * cols + i] * (1 - tx) + grid[(j + 1) * cols + i + 1] * tx
  return a * (1 - ty) + b * ty
}

/** Keep only the largest body of water: enclosed pockets become land. */
function fillEnclosedWater(land, w, h) {
  const comp = new Int32Array(w * h).fill(-1)
  const queue = new Int32Array(w * h)
  let best = -1
  let bestSize = 0
  let id = 0
  for (let start = 0; start < w * h; start++) {
    if (land[start] || comp[start] >= 0) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    comp[start] = id
    while (head < tail) {
      const k = queue[head++]
      const x = k % w
      const neighbours = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]
      for (const q of neighbours) {
        if (q < 0 || q >= w * h || land[q] || comp[q] >= 0) continue
        comp[q] = id
        queue[tail++] = q
      }
    }
    if (tail > bestSize) {
      bestSize = tail
      best = id
    }
    id++
  }
  for (let k = 0; k < w * h; k++) if (!land[k] && comp[k] !== best) land[k] = 1
}

/**
 * Squared Euclidean distance (in cells) from every cell to the nearest cell
 * whose mask value equals `target` (Felzenszwalb & Huttenlocher, O(n)).
 */
function edt(mask, w, h, target) {
  const INF = 1e20
  const grid = new Float64Array(w * h)
  for (let k = 0; k < w * h; k++) grid[k] = mask[k] === target ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (len) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      d[q] = (q - v[k]) ** 2 + f[v[k]]
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    pass(h)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    pass(w)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]
  }
  return grid
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function newSeed() {
  return (Math.random() * 2 ** 32) >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value noise with a seeded random permutation. */
function makeNoise(rand) {
  const perm = new Uint8Array(512)
  const values = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    perm[i] = i
    values[i] = rand()
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[perm[i], perm[j]] = [perm[j], perm[i]]
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]
  const at = (x, y) => values[perm[perm[x & 255] + (y & 255)]]
  return (x, y) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    let tx = x - xi
    let ty = y - yi
    tx = tx * tx * (3 - 2 * tx)
    ty = ty * ty * (3 - 2 * ty)
    const a = at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx
    const b = at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx
    return a * (1 - ty) + b * ty
  }
}

function fbm(noise, x, y) {
  let v = 0
  let a = 0.5
  for (let i = 0; i < 5; i++) {
    v += a * noise(x, y)
    x = x * 2.03 + 17.1
    y = y * 2.03 + 9.7
    a *= 0.5
  }
  return v
}
