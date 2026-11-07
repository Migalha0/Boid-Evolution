import { generateLogs } from './Logs.js'
import { evalCurve } from './curve.js'
import { PLANT, PLANT_KINDS, Vegetation } from './Vegetation.js'

/** World px per elevation sample. */
export const ELEV_CELL = 6
/** World px per signed-distance sample. */
export const SDF_CELL = 3
/** Elevation above which the floor breaks the surface and becomes land. */
export const LAND_LEVEL = 0.8
/** px per cell of the plants' colour-region grid (PondMap.tint). */
export const TINT_CELL = 8
/** Elevation where aquatic vegetation starts to appear. */
const VEG_START = 0.5
/**
 * Even where the shallows are planted, plants in the water stand this far
 * apart (as a share of the land's cover), so water shows between them,
 * closing up gradually towards the bank.
 */
const WATER_COVER = 0.45
/**
 * Most of the water that may be plant habitat (shallow enough): past this
 * share (low water, a shallow map) the water plants thin out evenly, so about
 * as much water stays open as on a deeper pond.
 */
const ZONE_MAX = 0.45
/** Plant habitat: water at least this shallow (PondMap.shallowness). */
const ZONE_SHALLOW = 0.35
/**
 * Where a spot lies for the growth curve (habitatAt): 0 well inland (LAND_SPAN
 * px or more from the water) .. SHORE_X at the shoreline .. 1 in water too
 * deep for plants (shallowness 0).
 */
export const SHORE_X = 0.3
const LAND_SPAN = 150
/** How much grows along the habitat (PondMap.growth): [x, growth] points; 1 = fully planted, above 1 denser still. */
export const GROWTH_DEFAULT = [
  [0, 0.8],
  [0.2, 0.9],
  [SHORE_X, 1],
  [0.45, 0.8],
  [0.65, 0.45],
  [0.8, 0.15],
  [1, 0],
]
/** In bare holes and clearings, a few tufts still grow (share of the plants there would be). */
const TUFTS = 0.06
/** Reed beds are judged on a grid of cells this size (px). */
const REED_CELL = 8

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
 *  - vegetation: plants on land and in the shallows, as much as the growth
 *    curve says for where a spot lies (habitatAt: inland, the shore, the
 *    shallows, the deep). Below full growth the plants thin out, and where
 *    growth is low the ground opens in irregular holes and clearings. Plants next to a trunk grow away from it (on land
 *    only partly, see landClearing).
 */
export class PondMap {
  constructor() {
    this.vegetation = new Vegetation()
    this.seed = newSeed()
    this.width = 0
    this.height = 0
    /** Visible part of the map [x, y, w, h]; spawning prefers it. */
    this.view = null
    this.version = 0
    /** How much grows where: the growth curve (GROWTH_DEFAULT). */
    this.growth = GROWTH_DEFAULT
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
    /** How deep the water is, as a multiple of the generated depth (the shore stays where it is). */
    this.waterDepth = 1
    /** How much of the map is land: 0 = open water to the banks, 1 = as generated, 2 = mostly land. */
    this.landAmount = 1
  }

  layout(width, height) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.generate()
  }

  /** A new map (at a new size, if given). */
  newMap(width = this.width, height = this.height) {
    this.seed = newSeed()
    this.width = width
    this.height = height
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

  /** The same map with the water at a new depth: floor, plants and trunks are laid again. */
  setWaterDepth(depth) {
    if (depth === this.waterDepth) return
    this.waterDepth = depth
    if (this.width) this.generate()
  }

  /** The same map with more or less land (the floor raised or lowered under the same surface). */
  setLandAmount(amount) {
    if (amount === this.landAmount) return
    this.landAmount = amount
    if (this.width) this.generate()
  }

  /** Regrow the plants alone (same floor and shore), e.g. after the growth curve changes. */
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
    const shore = Math.min(0.99, Math.max(0.3, LAND_LEVEL + (1 - this.landAmount) * 0.2))
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        const x = Math.min(W, i * ELEV_CELL)
        const y = Math.min(H, j * ELEV_CELL)
        // Raised banks along the border, with a noisy width -> squiggly shore.
        const edge = Math.min(x, y, W - x, H - y)
        const bank = 2 + 17 * smoothstep(0.3, 0.7, fbm(noise, x * 0.012 + 31.7, y * 0.012 + 11.3))
        // More or less land: the shore moves to `shore` on the noise, and the
        // range below and above it is stretched back to water and land.
        const v = (e[k] - min) / (max - min || 1)
        const lifted = v < shore ? (v / shore) * LAND_LEVEL : LAND_LEVEL + ((v - shore) / (1 - shore)) * (1 - LAND_LEVEL)
        e[k] = Math.min(1, lifted + 0.95 * (1 - smoothstep(0, bank, edge)))
        // Deeper or shallower water: the floor scaled away from the surface,
        // land untouched (a floor deeper than the deepest flattens out).
        if (e[k] < LAND_LEVEL) e[k] = Math.max(0, LAND_LEVEL - (LAND_LEVEL - e[k]) * this.waterDepth)
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
    const brownAt = (x, y) => smoothstep(0.48, 0.66, fbm(tones, x * 0.0035, y * 0.0035))
    const yellowAt = (x, y) => smoothstep(0.48, 0.66, fbm(tones, x * 0.0035 + 91.7, y * 0.0035 + 23.1))
    const brown = (x, y) => jitter(brownAt(x, y))
    const yellow = (x, y) => jitter(yellowAt(x, y))
    // The same regions as a coarse grid (brown, yellow per TINT_CELL px), so
    // the soil can take the tint of the plants growing there.
    const tc = Math.ceil(this.width / TINT_CELL) + 1
    const tr = Math.ceil(this.height / TINT_CELL) + 1
    const tint = new Uint8Array(tc * tr * 2)
    for (let j = 0; j < tr; j++) {
      for (let i = 0; i < tc; i++) {
        tint[(j * tc + i) * 2] = Math.round(255 * brownAt(i * TINT_CELL, j * TINT_CELL))
        tint[(j * tc + i) * 2 + 1] = Math.round(255 * yellowAt(i * TINT_CELL, j * TINT_CELL))
      }
    }
    this.tint = { cols: tc, rows: tr, data: tint }
    const claimAt = this.makeClaims(rand, noise)
    // Holes and clearings: where a noise field (broad shapes broken up by
    // finer ones, so a big clearing is ragged and dotted with plants rather
    // than bare through the middle) is below the level that leaves `share`
    // of the ground planted. Levels are this map's own quantiles of it.
    const holeNoise = (x, y) => 0.45 * fbm(noise, x * 0.004 + 517.3, y * 0.004 + 211.9) + 0.55 * fbm(noise, x * 0.016 + 311.7, y * 0.016 + 87.3)
    const sorted = []
    for (let k = 0; k < 4096; k++) sorted.push(holeNoise(((k * 0.618034) % 1) * this.width, (k / 4096) * this.height))
    sorted.sort((a, b) => a - b)
    const holeLevel = (share) => sorted[Math.min(4095, Math.max(0, Math.floor((1 - share) * 4095)))]
    // Planted here (0..1), for a share planted; holes thin out over their
    // edges rather than stopping at a line.
    const unHoled = (x, y, share) => {
      if (share >= 1) return 1
      if (share <= 0) return TUFTS
      const level = holeLevel(share)
      return Math.max(TUFTS, smoothstep(level - 0.05, level + 0.05, holeNoise(x, y)))
    }
    // The growth curve at a spot, everywhere (right up to the shore on either
    // side): how much of the ground is planted (holes and clearings take the
    // rest) and how densely, together making the growth. Mostly it thins;
    // holes open up in earnest only where growth is low (above 1: none, denser).
    const growthAt = (d, shallow) => {
      const g = Math.max(0, evalCurve(this.growth, this.habitatAt(d, shallow)))
      const share = Math.min(1, Math.cbrt(g))
      return { share, dense: g <= 1 ? (share > 0 ? g / share : 0) : g }
    }
    // Mostly shallow water: the water plants thin out to keep some open.
    const zone = this.plantZoneShare()
    const open = zone > ZONE_MAX ? ZONE_MAX / zone : 1
    // Trunks lie where they fell. In the water nothing grows under one, and
    // plants beside it are bent away from it (and kept short enough), so the
    // trunk shows. On land (drawn over the plants anyway) they only make way
    // by landClearing, so the ground stays covered.
    const reachMax = Math.max(...PLANT_KINDS.map((k) => k.length[1])) * 1.4
    // Ground a plant of each kind covers seen from above (its blades and head).
    const COVER = PLANT_KINDS.map((k) => k.blades * ((k.length[0] + k.length[1]) / 2) * k.width + (k.head ? k.head.length * k.head.width : 0))
    // What grows where: [kind, share] per habitat, picked in this order.
    const LAND = [[PLANT.REED, 0.62], [PLANT.CATTAIL, 0.3], [PLANT.IRIS, 0.08]]
    const SHALLOW = [[PLANT.CATTAIL, 0.33], [PLANT.REED, 0.47], [PLANT.IRIS, 0.11], [PLANT.PICKERELWEED, 0.09]]
    // Pickerelweed favours the middle shallows.
    const MIDDLE = [[PLANT.REED, 0.74], [PLANT.PICKERELWEED, 0.16], [PLANT.CATTAIL, 0.06], [PLANT.IRIS, 0.04]]
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
    // ground: a cattail's place takes about two reeds), above 1 a fraction
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
            // Too cramped to grow: in the water never, on land as often as the
            // clearing says (a position hash, not the random stream, so the
            // rest of the layout stays put); the rest stay as stubs.
            if (!land || cellHash(x, y) < clear) return
            scale = 0.3
          }
        }
      }
      // Nothing grows off screen (the world's margin round the view): no
      // flowers or shelter out there to draw midges out of view. Checked
      // last, so the random stream and the rest of the layout stay as they were.
      if (this.insideView(x, y) < 0) return
      veg.add(kind, x, y, scale, rot, seed, br, ye, land)
    }
    for (let gy = 0; gy * G < this.height; gy++) {
      for (let gx = 0; gx * G < this.width; gx++) {
        const x = (gx + rand()) * G
        const y = (gy + rand()) * G
        const d = this.distanceAt(x, y)
        const patch = 0.55 + 0.6 * fbm(noise, x * 0.02, y * 0.02) // clumpy, never uniform
        if (d < 0) {
          // Land: as the curve says, low and close.
          const g = growthAt(d, 0)
          if (rand() > 0.9 * patch * g.dense * unHoled(x, y, g.share)) continue
          const r = rand()
          const kind = claimAt(x, y) ?? pick(LAND, r)
          add(kind, x, y, 0.75 + rand() * 0.3, rotation(x, y), rand(), brown(x, y), yellow(x, y), true, LAND)
          continue
        }
        const shallow = this.shallowness(x, y, d)
        // As the curve says; in the lush shallows the plants stand apart so
        // water shows between them, closer together towards the bank (over
        // 30 px, so the shore has no band of its own).
        const g = growthAt(d, shallow)
        const lush = smoothstep(0.45, 0.9, shallow)
        const bank = 1 - smoothstep(0, 30, d)
        const cover = 1 - lush * (1 - bank) * (1 - WATER_COVER)
        const opened = bank + (1 - bank) * open
        if (rand() > Math.min(1, 1.2 * patch) * g.dense * unHoled(x, y, g.share) * cover * opened) continue
        const r = rand()
        // The deep edge grows only short reeds, but takes from the middle mix in their place.
        const mix = shallow > 0.7 ? SHALLOW : MIDDLE
        const edge = shallow <= ZONE_SHALLOW
        const kind = claimAt(x, y) ?? (edge ? PLANT.REED : pick(mix, r))
        add(kind, x, y, (0.75 + shallow * 0.4 + rand() * 0.2) * (edge ? 0.6 : 1), rotation(x, y), rand(), brown(x, y), yellow(x, y), false, mix)
      }
    }

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

  /** Where a spot lies for the growth curve (SHORE_X): by its distance inland on land (d < 0), by its shallowness in water. */
  habitatAt(d, shallow) {
    return d < 0 ? SHORE_X * (1 - Math.min(1, -d / LAND_SPAN)) : SHORE_X + (1 - SHORE_X) * (1 - shallow)
  }

  /** Share of the water that is plant habitat (shallow enough), sampled every 8 px. */
  plantZoneShare() {
    let water = 0
    let zone = 0
    for (let y = 4; y < this.height; y += 8) {
      for (let x = 4; x < this.width; x += 8) {
        const d = this.distanceAt(x, y)
        if (d < 0) continue
        water++
        if (this.shallowness(x, y, d) > ZONE_SHALLOW) zone++
      }
    }
    return water ? zone / water : 0
  }

  /** Whether (x, y) is in a reed bed: its grid cell's centre is water this vegetated. */
  inReeds(x, y) {
    const i = Math.floor(x / REED_CELL)
    const j = Math.floor(y / REED_CELL)
    if (i < 0 || j < 0 || i >= Math.ceil(this.width / REED_CELL) || j >= Math.ceil(this.height / REED_CELL)) return false
    const cx = (i + 0.5) * REED_CELL
    const cy = (j + 0.5) * REED_CELL
    const d = this.distanceAt(cx, cy)
    return d >= 0 && this.shallowness(cx, cy, d) > 0.45
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
  /** How far (x, y) is inside the visible part of the map (px; negative off screen). */
  insideView(x, y) {
    const [vx, vy, vw, vh] = this.view ?? [0, 0, this.width, this.height]
    return Math.min(x - vx, y - vy, vx + vw - x, vy + vh - y)
  }

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

/** 0..1, fixed for a position. */
function cellHash(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
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
