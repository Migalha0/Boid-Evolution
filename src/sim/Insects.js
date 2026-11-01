import * as G_ from './genetics.js'
import { PLANT, PLANT_KINDS, PLANT_STRIDE } from './Vegetation.js'

/**
 * Floats per point in `data` (the GPU vertex buffer):
 * x, y, height above the water, state, seed, ripple age / heading, egg maturity, selected.
 * The buffer holds the midges, then their egg rafts, then the ripples.
 * (Dragonflies.js fills its own buffer in this layout, with DRAGONFLY points.)
 */
export const INSECT_STRIDE = 8
/** What a point is (data[3]); the renderer draws by state. */
export const FLYING = 0
export const ON_WATER = 1
export const ON_FLOWER = 2
export const FALLING = 3 // just died, dropping
export const DEAD = 4 // a body on the water or the ground
export const EGGS = 5 // an egg raft on the water
export const EMPTY = 6
export const RIPPLE = 7 // a ring on the water (data[5] = its age)
export const DRAGONFLY = 8 // a hunting dragonfly (data[5] = its heading, data[6] = its colour)
export const DRAGON_EGGS = 9 // a dragonfly's clutch on the water (data[6] = ripeness, data[7] = eggs)

/**
 * The genome: every midge carries its own value of each gene, drawn at random
 * for the first flock and inherited (with mutations) from its mother after.
 * Ranges bound both the random draw and mutations.
 */
export const GENES = [
  { key: 'speed', label: 'Speed', min: 20, max: 150, unit: ' px/s', hint: 'faster flight burns more energy' },
  { key: 'range', label: 'Search range', min: 40, max: 600, unit: ' px', hint: 'how far it looks for flowers and new spots' },
  { key: 'hungry', label: 'Feeds below', min: 0.1, max: 0.9, unit: '', hint: 'energy at which it goes to drink' },
  { key: 'wander', label: 'Moves spot', min: 0, max: 0.6, unit: ' /s' },
  { key: 'swarming', label: 'Joins swarms', min: 0, max: 1, unit: '', hint: 'chance a new spot is one others dance over' },
  { key: 'landing', label: 'Lands', min: 0, max: 0.6, unit: ' /s' },
  { key: 'rest', label: 'Rests for', min: 0.5, max: 15, unit: ' s' },
  { key: 'purple', label: 'Likes purple', min: 0, max: 3, unit: '' },
  { key: 'yellow', label: 'Likes yellow', min: 0, max: 3, unit: '' },
  { key: 'scum', label: 'Likes scum', min: 0, max: 3, unit: '' },
  { key: 'shade', label: 'Prefers shade', min: 0, max: 1, unit: '' },
  { key: 'cohesion', label: 'Cohesion', min: 0, max: 3, unit: '' },
  { key: 'separation', label: 'Separation', min: 0, max: 3, unit: '' },
  { key: 'vigilance', label: 'Vigilance', min: 0, max: 1, unit: '', hint: 'how far off it flees a hunting dragonfly (15 to 90 px); fleeing burns 3x the energy' },
  { key: 'sunShy', label: 'Rests in sun', min: 0, max: 1, unit: '', hint: 'out in the sun (where dragonflies are fastest) it lands more and rests longer, and lays less' },
  { key: 'laying', label: 'Lays', min: 0, max: 0.2, unit: ' /s' },
  { key: 'eggEnergy', label: 'Lays above', min: 0.2, max: 1, unit: '', hint: 'energy it needs to lay' },
  { key: 'brood', label: 'Eggs per raft', min: 1, max: 4, unit: '', hint: 'each egg takes 0.25 energy from the mother, all its hatchling starts with' },
]
const NG = GENES.length
const G = Object.fromEntries(GENES.map((g, k) => [g.key, k]))

/** Attractor kinds. */
const PURPLE = 0
const YELLOW = 1
const SCUM = 2
/** Most scum spots kept as attractors (sampled evenly from the mat). */
const MAX_SCUM_SPOTS = 4000
/** Seconds a ripple lasts (must match insectFS). */
export const RIPPLE_LIFE = 0.9
const RIPPLES = 256
/** Neighbours within this many px pull together (cohesion); within SEPARATION they push apart. */
const NEIGHBOUR_RADIUS = 24
const SEPARATION = 16
/** Forces of the dance (px/s² per px or per unit of gene). */
const HOME_PULL = 2.5
const COHESION = 5
const SEPARATION_PUSH = 450
/** Random buzz, scaled so its effect doesn't depend on the frame rate. */
const JITTER = 100
const DRAG = 2.5
/** How far from home a midge will go to lay (px). */
const LAY_REACH = 350
/** Most neighbours a midge looks at per frame. */
const MAX_NEIGHBOURS = 12
/** Shelter grid: px per cell, and plants per cell that block the wind fully. */
const SHELTER_CELL = 16
const SHELTER_FULL = 8
/** Spot grid (flowers and scum, for searching within a range): px per cell. */
const SPOT_CELL = 48
/** What a midge is busy with besides dancing. */
const NONE = 0
const LANDING = 1
const LAYING = 2
/** Mean seconds between a dancing midge's decisions (wander, land, lay). */
const DECIDE = 1.25
/** Feeding: energy drunk per second; flowers holding less than MIN_NECTAR aren't worth the trip. */
const FEED_RATE = 0.25
const MIN_NECTAR = 0.1
/** Energy burnt resting, relative to flying. */
const REST_DRAIN = 0.3
/**
 * Energy a mother puts into each egg, and all a hatchling starts with: energy
 * is only passed on, never made, so every midge's energy comes from nectar.
 * She lays only as many eggs as she can afford (keeping EGG_RESERVE).
 */
const EGG_ENERGY = 0.25
const EGG_RESERVE = 0.05
/** Flight speed (px/s) at which flying burns exactly `insectHunger`; beyond a base cost it grows with speed squared. */
const CRUISE = 70
/** Midge slots to start with when the population has no cap (they grow as needed). */
const UNLIMITED_START = 1024
/**
 * A midge flees a hunting dragonfly within FLEE_NEAR + FLEE_FAR * vigilance
 * px, steering this hard (px/s²) and burning FLEE_COST times its flight energy.
 */
const FLEE_NEAR = 15
const FLEE_FAR = 75
const FLEE_ACCEL = 900
const FLEE_COST = 3
/** Seconds between nectar updates sent to the renderer, and between population samples. */
const BLOOM_TICK = 0.1
const HISTORY_TICK = 2
const HISTORY_LENGTH = 300

/** Midge genomes (see genetics.js). */
export const randomGenome = () => G_.randomGenome(GENES)
export const genomeToObject = (genome) => G_.genomeToObject(GENES, genome)
export const objectToGenome = (obj) => G_.objectToGenome(GENES, obj)

/**
 * Midges: tiny flies dancing in loose clouds over what draws them (purple
 * pickerelweed, yellow iris and the scum mats), simulated on the CPU (a few
 * thousand at most) and drawn as points. How each one behaves is set by its
 * own genome (GENES); nothing groups them but what the genes make them do,
 * so swarms and where they settle emerge from feeding and breeding.
 *
 * The dance is a little boid: a weak pull to its home spot, cohesion towards
 * the midges around and separation from those too close (over a grid rebuilt
 * every frame), random buzz and drag. The wind pushes it downwind, less where
 * plants and trunks shelter it. Every so often a midge moves to a new home
 * spot within its search range (often one others already dance over),
 * perches on its flower, settles on the water, or goes off to lay an egg raft
 * at the rim of a lily pad or a scum mat.
 *
 * Hunger: flying burns energy (`insectHunger` per second at cruising speed,
 * more the faster it flies, less at rest). A hungry midge flies to the
 * nearest flower with nectar within its range and drinks until full; finding
 * none it moves on. Each flower holds `flowerNectar` meals' worth and fades as
 * it is drunk; one drunk dry closes until it has refilled, which takes
 * `flowerRegrow` seconds. After about `flowerRefills` refills a flower wilts
 * and rests for about `flowerDormancy` seconds before refilling, each flower
 * on its own cycle. A midge lays only above its egg energy, each egg costs
 * energy, and one that runs out of energy dies.
 *
 * Predators: whatever is set as `predators` (the dragonflies, a species of
 * their own: Dragonflies.js) hunts flying midges, and calls eaten() on a
 * catch. A midge flees a hunting one that comes within its vigilance, at
 * its own top speed, so fast midges get away and slow ones get eaten: the
 * pressure that speed's energy cost is weighed against. Fleeing is costly,
 * so vigilance is a trade too. Dragonflies miss more in a crowd of flying
 * midges and are slower in the shade; a sun-shy midge rests out the sun.
 *
 * Evolution: rafts carry their mother's genome; each hatchling mutates it
 * (each gene with chance `mutationRate`, by `mutationSize` of its range). With
 * `midgeLocked` and a `midgeProfile`, every midge gets the profile's genome
 * exactly. Nothing spawns by itself: a flock of `insectStart` appears only
 * when seed() is called (the user's spawn button); if the midges die out
 * they stay gone.
 *
 * Life cycle: a midge lives for about `insectLifespan` seconds, then drops
 * where it is and lies there as a body for `insectBodyTime` seconds. Egg
 * rafts hatch after `insectHatch` seconds into new midges, as long as the
 * population is below `insectCount`.
 */
export class Insects {
  constructor(map, pads) {
    this.map = map
    this.pads = pads
    this.capacity = 0 // midge slots (the population cap)
    this.eggSlots = 0
    this.data = new Float32Array(0)
    this.points = 0 // points in `data` the renderer draws
    this.alive = 0
    this.nextRipple = 0
    // Attractors: x, y per spot, with its kind; flowers first, then scum.
    this.spots = new Float32Array(0)
    this.spotKinds = new Uint8Array(0)
    this.spotGrid = null
    this.plantVersion = -1
    this.padVersion = -1
    this.scumSpots = new Float32Array(0)
    // Where eggs may go: lily pads (x, y, radius) and scum spots.
    this.padSpots = new Float32Array(0)
    this.time = 0
    // Light reaching the surface (renderer readback): 1 = full sun.
    this.shade = null
    this.shelter = null
    // Flowers are spots 0..flowerCount-1; flowerPlant maps them to their plant.
    this.flowerCount = 0
    this.flowerPlant = new Int32Array(0)
    // Per plant: drunk dry and refilling (vegetation.bloom holds the nectar).
    this.closed = new Uint8Array(0)
    this.regrown = new Float32Array(0)
    this.quota = new Float32Array(0)
    this.dormant = new Float32Array(0)
    this.closedVersion = -1
    this.bloomClock = 0
    // Evolution bookkeeping.
    this.nextId = 1
    this.selectedId = 0
    this.extinctions = 0
    this.present = false // any midges or rafts (so dying out can be told from never spawned)
    this.extinct = false
    // How midges died: old age, starvation, eaten by a dragonfly.
    this.deaths = { aged: 0, starved: 0, eaten: 0 }
    // Whatever hunts them (Dragonflies, set by the owner): asked whom to flee.
    this.predators = null
    this.history = []
    this.historyClock = 0
    this.lockedProfile = null
    this.version = 0 // bumped whenever `data` changes
  }

  /** World positions of scum fronds (renderer readback), sampled down. */
  setScum(points) {
    const n = points.length / 2
    const step = Math.max(1, n / MAX_SCUM_SPOTS)
    const kept = new Float32Array(Math.floor(n / step) * 2)
    for (let i = 0; i < kept.length / 2; i++) {
      const j = Math.floor(i * step) * 2
      kept[i * 2] = points[j]
      kept[i * 2 + 1] = points[j + 1]
    }
    this.scumSpots = kept
    this.plantVersion = -1 // rebuild the attractors
  }

  /**
   * Light on the surface, from the renderer (plant, scum and trunk shadows and
   * cloud shade): one value per texel, rows bottom-up, `cell` world px each,
   * covering the view from `offset`.
   */
  setShade(values, w, h, cell, offset) {
    this.shade = { values, w, h, cell, offset }
  }

  /** 0 (deep shade) .. 1 (full sun) at a world position; outside the view, sun. */
  sunAt(x, y) {
    const s = this.shade
    if (!s) return 1
    const i = Math.floor((x - s.offset[0]) / s.cell[0])
    const j = s.h - 1 - Math.floor((y - s.offset[1]) / s.cell[1])
    if (i < 0 || j < 0 || i >= s.w || j >= s.h) return 1
    return s.values[(j * s.w + i) * 4]
  }

  /** Flower heads, scum spots and the wind shelter, rebuilt when the plants change. */
  syncSpots() {
    const veg = this.map.vegetation
    const pads = this.pads
    if (veg.version === this.plantVersion && pads.version === this.padVersion) return
    this.plantVersion = veg.version
    this.padVersion = pads.version
    this.padSpots = new Float32Array(pads.count * 3)
    for (let i = 0; i < pads.count; i++) this.padSpots.set(pads.data.subarray(i * 8, i * 8 + 3), i * 3)
    const xs = []
    const kinds = []
    const plantOf = []
    const map = this.map
    const sw = Math.max(1, Math.ceil(map.width / SHELTER_CELL))
    const sh = Math.max(1, Math.ceil(map.height / SHELTER_CELL))
    const plants = new Float32Array(sw * sh)
    for (let i = 0; i < veg.count; i++) {
      const o = i * PLANT_STRIDE
      const x = veg.data[o]
      const y = veg.data[o + 1]
      const cell = Math.min(sh - 1, Math.max(0, Math.floor(y / SHELTER_CELL))) * sw + Math.min(sw - 1, Math.max(0, Math.floor(x / SHELTER_CELL)))
      plants[cell]++
      const kind = veg.data[o + 4]
      const colour = kind === PLANT.PICKERELWEED ? PURPLE : kind === PLANT.IRIS ? YELLOW : -1
      if (colour < 0) continue
      // The flower sits at the tip of the central blade.
      const reach = PLANT_KINDS[kind].length[1] * veg.data[o + 2] * 0.8
      const rot = veg.data[o + 3]
      xs.push(x + Math.cos(rot) * reach, y + Math.sin(rot) * reach)
      kinds.push(colour)
      plantOf.push(i)
    }
    this.flowerCount = plantOf.length
    this.flowerPlant = Int32Array.from(plantOf)
    if (this.closedVersion !== veg.version) {
      this.closed = new Uint8Array(veg.count)
      // The flower cycle: nectar regrown since it last rested (in full
      // refills), how many refills until it rests (drawn per flower), and
      // seconds left resting. Each starts somewhere in its cycle.
      this.regrown = new Float32Array(veg.count)
      this.quota = new Float32Array(veg.count).fill(-1)
      this.dormant = new Float32Array(veg.count)
      this.closedVersion = veg.version
    }
    for (let i = 0; i < this.scumSpots.length; i += 2) {
      xs.push(this.scumSpots[i], this.scumSpots[i + 1])
      kinds.push(SCUM)
    }
    this.spots = Float32Array.from(xs)
    this.spotKinds = Uint8Array.from(kinds)
    this.buildSpotGrid()

    // Shelter from the wind: plant cover, and trunks block it fully.
    const shelter = new Float32Array(sw * sh)
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const k = j * sw + i
        const near = map.logs.length ? map.logClearance((i + 0.5) * SHELTER_CELL, (j + 0.5) * SHELTER_CELL, SHELTER_CELL) : null
        shelter[k] = near && near.gap < SHELTER_CELL * 0.5 ? 1 : Math.min(1, plants[k] / SHELTER_FULL)
      }
    }
    this.shelter = { values: shelter, w: sw, h: sh }

    // Homes refer to spot indices: everyone alive picks again.
    for (let i = 0; i < this.capacity; i++) if (this.isAdult(i)) this.home[i] = this.pickHome(i, this.data[i * INSECT_STRIDE], this.data[i * INSECT_STRIDE + 1])
  }

  /** Spots by grid cell (counting sort), for searches within a range. */
  buildSpotGrid() {
    const w = Math.max(1, Math.ceil(this.map.width / SPOT_CELL))
    const h = Math.max(1, Math.ceil(this.map.height / SPOT_CELL))
    const n = this.spots.length / 2
    const start = new Int32Array(w * h + 1)
    const cellOf = new Int32Array(n)
    for (let s = 0; s < n; s++) {
      const cx = Math.min(w - 1, Math.max(0, Math.floor(this.spots[s * 2] / SPOT_CELL)))
      const cy = Math.min(h - 1, Math.max(0, Math.floor(this.spots[s * 2 + 1] / SPOT_CELL)))
      cellOf[s] = cy * w + cx
      start[cellOf[s] + 1]++
    }
    for (let c = 0; c < w * h; c++) start[c + 1] += start[c]
    const fill = start.slice(0, w * h)
    const items = new Int32Array(n)
    for (let s = 0; s < n; s++) items[fill[cellOf[s]]++] = s
    this.spotGrid = { w, h, start, items }
  }

  /** A random spot within `range` of (x, y) (rejection-sampled over the grid), or -1. */
  spotWithin(x, y, range) {
    const g = this.spotGrid
    if (!g) return -1
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * Math.PI * 2
      const d = Math.sqrt(Math.random()) * range
      const cx = Math.floor((x + Math.cos(a) * d) / SPOT_CELL)
      const cy = Math.floor((y + Math.sin(a) * d) / SPOT_CELL)
      if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) continue
      const c = cy * g.w + cx
      const n = g.start[c + 1] - g.start[c]
      if (n) return g.items[g.start[c] + Math.floor(Math.random() * n)]
    }
    return -1
  }

  shelterAt(x, y) {
    const s = this.shelter
    if (!s) return 0
    const i = Math.min(s.w - 1, Math.max(0, Math.floor(x / SHELTER_CELL)))
    const j = Math.min(s.h - 1, Math.max(0, Math.floor(y / SHELTER_CELL)))
    return s.values[j * s.w + i]
  }

  isAdult(i) {
    const st = this.data[i * INSECT_STRIDE + 3]
    return st === FLYING || st === ON_WATER || st === ON_FLOWER
  }

  /** Midge i's value of a gene. */
  gene(i, key) {
    return this.genes[i * NG + G[key]]
  }

  /**
   * Resize to `cap` midge slots (the population cap), keeping who is there.
   */
  setCapacity(cap, params) {
    cap = Math.max(0, Math.round(cap))
    if (cap === this.capacity) return
    const old = this.capacity
    const oldEggs = this.eggSlots
    const eggSlots = Math.max(16, Math.ceil(cap / 2))
    const data = new Float32Array((cap + eggSlots + RIPPLES) * INSECT_STRIDE)
    const keep = Math.min(old, cap) * INSECT_STRIDE
    data.set(this.data.subarray(0, keep))
    const keepEggs = Math.min(oldEggs, eggSlots)
    data.set(this.data.subarray(old * INSECT_STRIDE, (old + keepEggs) * INSECT_STRIDE), cap * INSECT_STRIDE)
    const resize = (a, w, n = cap) => {
      const b = new (a?.constructor ?? Float32Array)(n * w)
      if (a) b.set(a.subarray(0, Math.min(a.length, n * w)))
      return b
    }
    this.vel = resize(this.vel, 2)
    this.home = resize(this.home ?? new Int32Array(0), 1)
    // Seconds left resting.
    this.timer = resize(this.timer, 1)
    // Where it is heading to land or lay; what for; on a flower?
    this.target = resize(this.target, 2)
    this.action = resize(this.action ?? new Uint8Array(0), 1)
    this.onFlower = resize(this.onFlower ?? new Uint8Array(0), 1)
    // Age and lifespan (s); for a body, seconds until it is gone.
    this.age = resize(this.age, 1)
    this.life = resize(this.life, 1)
    // 0 (starving) .. 1 (full), and the flower it is drinking from (-1: none).
    this.energy = resize(this.energy, 1)
    this.feed = resize(this.feed ?? new Int32Array(0), 1)
    // Genome, generation, id, hatchlings raised, eggs laid.
    this.genes = resize(this.genes, NG)
    this.generation = resize(this.generation, 1)
    this.ids = resize(this.ids ?? new Uint32Array(0), 1)
    this.children = resize(this.children, 1)
    this.laid = resize(this.laid, 1)
    // Each raft: its mother's genome, generation and id.
    this.eggGenes = resize(this.eggGenes, NG, eggSlots)
    this.eggGeneration = resize(this.eggGeneration, 1, eggSlots)
    this.eggMother = resize(this.eggMother ?? new Uint32Array(0), 1, eggSlots)
    this.grid = { start: null, items: new Int32Array(cap) }
    this.data = data
    for (let i = old; i < cap; i++) data[i * INSECT_STRIDE + 3] = EMPTY
    for (let e = keepEggs; e < eggSlots; e++) data[(cap + e) * INSECT_STRIDE + 3] = EMPTY
    for (let r = 0; r < RIPPLES; r++) data[(cap + eggSlots + r) * INSECT_STRIDE + 3] = EMPTY
    this.capacity = cap
    this.eggSlots = eggSlots
    this.points = cap + eggSlots + RIPPLES
    this.version++
  }

  /**
   * A fresh flock of `insectStart` (up to the cap) with staggered ages: random
   * genomes, or the given / locked profile's. Everyone else is cleared.
   */
  seed(params, profile = params.midgeLocked ? params.midgeProfile : null) {
    if (!this.capacity) this.setCapacity(this.slotsFor(params.insectCount), params)
    for (let i = 0; i < this.capacity + this.eggSlots; i++) this.data[i * INSECT_STRIDE + 3] = EMPTY
    const genome = profile ? objectToGenome(profile.genes) : null
    const n = Math.min(this.capacity, Math.round(params.insectStart))
    for (let i = 0; i < n; i++) {
      const x = Math.random() * this.map.width
      const y = Math.random() * this.map.height
      // From a profile the flock still varies a little, unless locked.
      const g = genome ? this.mutate(genome, params, params.midgeLocked ? 0 : 1) : randomGenome()
      this.spawn(i, x, y, 6, g, 0, 0, params, 0.5 + Math.random() * 0.5)
      this.age[i] = Math.random() * this.life[i] * 0.5
    }
    this.version++
  }

  /**
   * Midge slots for a population cap: the cap itself, or with no cap
   * (Infinity) as many as there are, doubling whenever they are 3/4 full.
   */
  slotsFor(cap) {
    if (Number.isFinite(cap)) return cap
    if (!this.capacity) return UNLIMITED_START
    return this.alive > this.capacity * 0.75 ? this.capacity * 2 : this.capacity
  }

  /** A copy of a genome, each gene mutated with chance `mutationRate` * strength. */
  mutate(genome, params, strength = 1) {
    return G_.mutate(GENES, genome, params.mutationRate * strength, params.mutationSize)
  }

  /** A new midge in slot i with the given genome. */
  spawn(i, x, y, z, genome, generation, mother, params, energy) {
    const o = i * INSECT_STRIDE
    this.data[o] = x
    this.data[o + 1] = y
    this.data[o + 2] = z
    this.data[o + 3] = FLYING
    this.data[o + 4] = Math.random()
    this.data[o + 7] = 0
    this.genes.set(genome, i * NG)
    this.generation[i] = generation
    this.ids[i] = this.nextId++
    this.children[i] = 0
    this.laid[i] = 0
    this.vel[i * 2] = this.vel[i * 2 + 1] = 0
    this.timer[i] = 0
    this.action[i] = NONE
    this.age[i] = 0
    this.life[i] = params.insectLifespan * (0.7 + Math.random() * 0.6)
    this.energy[i] = energy
    this.feed[i] = -1
    this.home[i] = -1
    this.home[i] = this.pickHome(i, x, y)
  }

  ripple(x, y) {
    const r = this.capacity + this.eggSlots + this.nextRipple
    this.nextRipple = (this.nextRipple + 1) % RIPPLES
    const o = r * INSECT_STRIDE
    this.data[o] = x
    this.data[o + 1] = y
    this.data[o + 2] = 0
    this.data[o + 3] = RIPPLE
    this.data[o + 5] = 0
  }

  spotAt(s) {
    return [this.spots[s * 2], this.spots[s * 2 + 1]]
  }

  /**
   * A new home spot for midge i at (x, y), all by its genes: with its swarming
   * chance the spot of another midge within its range (unless that is out in
   * the sun), else the best of a few spots in range by what it likes, passed
   * over the sunnier they are. Keeps the current home if nothing is in range.
   */
  pickHome(i, x, y) {
    const gi = i * NG
    const genes = this.genes
    const range = genes[gi + G.range]
    const shade = genes[gi + G.shade]
    const weights = [genes[gi + G.purple], genes[gi + G.yellow], genes[gi + G.scum]]
    if (Math.random() < genes[gi + G.swarming]) {
      const adults = this.adults
      for (let k = 0; k < 4 && adults?.count; k++) {
        const j = adults.list[Math.floor(Math.random() * adults.count)]
        const h = this.home[j]
        if (j === i || h < 0 || !this.isAdult(j) || weights[this.spotKinds[h]] <= 0) continue
        const [hx, hy] = this.spotAt(h)
        if (Math.hypot(hx - x, hy - y) > range) continue
        if (Math.random() < shade * this.sunAt(hx, hy)) continue
        return h
      }
    }
    let best = this.home[i] ?? -1
    let bestScore = 0
    for (let k = 0; k < 6; k++) {
      const s = this.spotWithin(x, y, range)
      if (s < 0) continue
      const score = (weights[this.spotKinds[s]] * (0.5 + Math.random())) / (1 + 3 * shade * this.sunAt(...this.spotAt(s)))
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    return best
  }

  /** The nearest open flower with nectar of a few within `range` of (x, y), or -1. */
  flowerNear(x, y, range) {
    const bloom = this.map.vegetation.bloom
    let best = -1
    let bestD = Infinity
    for (let k = 0; k < 10; k++) {
      const f = this.spotWithin(x, y, range)
      if (f < 0 || f >= this.flowerCount) continue
      const p = this.flowerPlant[f]
      if (this.closed[p] || bloom[p] < MIN_NECTAR) continue
      const d = Math.hypot(this.spots[f * 2] - x, this.spots[f * 2 + 1] - y)
      if (d < bestD) {
        bestD = d
        best = f
      }
    }
    return best
  }

  /** Flying midges by grid cell (counting sort), for cohesion and separation; and the list of the living. */
  buildGrid() {
    const map = this.map
    const gw = Math.max(1, Math.ceil(map.width / NEIGHBOUR_RADIUS))
    const gh = Math.max(1, Math.ceil(map.height / NEIGHBOUR_RADIUS))
    const g = this.grid
    if (!g.start || g.start.length !== gw * gh + 1) {
      g.start = new Int32Array(gw * gh + 1)
      g.cellOf = new Int32Array(this.capacity)
    }
    if (g.cellOf.length !== this.capacity) g.cellOf = new Int32Array(this.capacity)
    g.w = gw
    g.h = gh
    const { start, items, cellOf } = g
    start.fill(0)
    const data = this.data
    // Everyone alive, for picking a swarm to join.
    if (this.adults?.list.length !== this.capacity) this.adults = { list: new Int32Array(this.capacity), count: 0 }
    this.adults.count = 0
    for (let i = 0; i < this.capacity; i++) if (this.isAdult(i)) this.adults.list[this.adults.count++] = i
    for (let i = 0; i < this.capacity; i++) {
      const o = i * INSECT_STRIDE
      if (data[o + 3] !== FLYING) {
        cellOf[i] = -1
        continue
      }
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(data[o] / NEIGHBOUR_RADIUS)))
      const cy = Math.min(gh - 1, Math.max(0, Math.floor(data[o + 1] / NEIGHBOUR_RADIUS)))
      const c = cy * gw + cx
      cellOf[i] = c
      start[c + 1]++
    }
    for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c]
    const fill = this.fill?.length === gw * gh ? this.fill : (this.fill = new Int32Array(gw * gh))
    fill.set(start.subarray(0, gw * gh))
    for (let i = 0; i < this.capacity; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i
  }

  /** Nectar refills; the renderer gets the new bloom now and then. */
  regrowFlowers(dt, params) {
    const veg = this.map.vegetation
    const bloom = veg.bloom
    const closed = this.closed
    const refill = dt / Math.max(params.flowerRegrow, 0.1)
    // The flower cycle: after about `flowerRefills` refills (0: never) a flower
    // wilts and rests for about `flowerDormancy` s, then refills from empty.
    const cycle = params.flowerRefills
    const { regrown, quota, dormant } = this
    for (let f = 0; f < this.flowerCount; f++) {
      const p = this.flowerPlant[f]
      if (dormant[p] > 0) {
        dormant[p] -= dt
        continue
      }
      if (bloom[p] >= 1) continue
      const add = Math.min(refill, 1 - bloom[p])
      bloom[p] += add
      if (bloom[p] >= 1) {
        bloom[p] = 1
        closed[p] = 0
      }
      if (cycle <= 0) continue
      if (quota[p] < 0) {
        quota[p] = cycle * (0.5 + Math.random())
        regrown[p] = Math.random() * quota[p]
      }
      regrown[p] += add
      if (regrown[p] >= quota[p]) {
        bloom[p] = 0
        closed[p] = 1
        dormant[p] = params.flowerDormancy * (0.7 + Math.random() * 0.6)
        regrown[p] = 0
        quota[p] = cycle * (0.5 + Math.random())
      }
    }
    this.bloomClock -= dt
    if (this.bloomClock > 0) return
    this.bloomClock = BLOOM_TICK
    veg.bloomVersion++
  }

  /**
   * Lock to (or unlock from) a profile: while locked every midge carries the
   * profile's genome exactly and hatchlings don't mutate.
   */
  syncLock(params) {
    const profile = params.midgeLocked ? params.midgeProfile : null
    if (profile === this.lockedProfile) return
    this.lockedProfile = profile
    if (!profile) return
    const genome = objectToGenome(profile.genes)
    for (let i = 0; i < this.capacity; i++) if (this.isAdult(i)) this.genes.set(genome, i * NG)
    for (let e = 0; e < this.eggSlots; e++) this.eggGenes.set(genome, e * NG)
  }

  /** Every living midge takes the profile's genome (they keep evolving unless locked). */
  applyProfile(profile) {
    const genome = objectToGenome(profile.genes)
    for (let i = 0; i < this.capacity; i++) if (this.isAdult(i)) this.genes.set(genome, i * NG)
    for (let e = 0; e < this.eggSlots; e++) this.eggGenes.set(genome, e * NG)
  }

  /**
   * @param params insectCount (population cap, Infinity for none), insectStart (fresh flock),
   *   insectWind (drift), insectLifespan / insectBodyTime / insectHatch (s),
   *   insectHunger (energy burnt per s at cruising speed), flowerNectar (meals
   *   per flower), flowerRegrow (s to refill), flowerRefills / flowerDormancy
   *   (the flower cycle), mutationRate /
   *   mutationSize, midgeProfile / midgeLocked, windDirection, cloudSpeed. The
   *   rest of how a midge behaves is in its genes.
   */
  update(dt, params) {
    this.syncSpots()
    this.setCapacity(this.slotsFor(params.insectCount), params)
    this.syncLock(params)
    this.regrowFlowers(dt, params)
    this.buildGrid()
    this.time += dt
    const { data, vel, home, target, map, energy, genes } = this
    const bloom = map.vegetation.bloom
    const closed = this.closed
    const hunger = params.insectHunger
    const a = (params.windDirection * Math.PI) / 180
    const windSpeed = params.cloudSpeed * params.insectWind
    const wind = [Math.sin(a) * windSpeed, -Math.cos(a) * windSpeed]
    // In a strong wind swarms keep low.
    const lowness = 1 / (1 + windSpeed / 25)
    // Chance per frame of making a decision at all.
    const pDecide = dt / DECIDE
    const buzz = (JITTER * 2) / Math.sqrt(Math.max(dt, 1e-3))
    const { start, items, w: gw, h: gh } = this.grid
    let alive = 0

    for (let i = 0; i < this.capacity; i++) {
      const o = i * INSECT_STRIDE
      const state = data[o + 3]
      if (state === EMPTY) continue
      const v = i * 2
      const gi = i * NG

      if (state === FALLING) {
        data[o + 2] -= 25 * dt
        data[o] += wind[0] * 0.3 * dt
        data[o + 1] += wind[1] * 0.3 * dt
        if (data[o + 2] <= 0) {
          data[o + 2] = 0
          data[o + 3] = DEAD
          this.life[i] = params.insectBodyTime * (0.7 + Math.random() * 0.6)
          if (map.distanceAt(data[o], data[o + 1]) >= 0) this.ripple(data[o], data[o + 1])
        }
        continue
      }
      if (state === DEAD) {
        this.life[i] -= dt
        if (this.life[i] <= 0) data[o + 3] = EMPTY
        continue
      }

      alive++
      this.age[i] += dt
      const speed = genes[gi + G.speed]
      if (state === ON_FLOWER && this.feed[i] >= 0) {
        // Drinking: until full or the flower runs dry (then it closes to refill).
        const p = this.flowerPlant[this.feed[i]]
        if (!closed[p]) {
          const take = Math.min(FEED_RATE * dt, bloom[p] * params.flowerNectar, 1 - energy[i])
          energy[i] += take
          bloom[p] -= take / params.flowerNectar
          if (bloom[p] <= 1e-3) {
            bloom[p] = 0
            closed[p] = 1
          }
        }
        if (!closed[p] && energy[i] < 0.98) this.timer[i] = Math.max(this.timer[i], 0.2)
      } else energy[i] -= hunger * (state === FLYING ? 0.3 + 0.7 * (speed / CRUISE) ** 2 : REST_DRAIN) * dt
      if (this.age[i] > this.life[i] || energy[i] <= 0) {
        // Its time is up, or it starved: it drops where it is.
        if (energy[i] <= 0) this.deaths.starved++
        else this.deaths.aged++
        data[o + 3] = state === FLYING ? FALLING : DEAD
        if (state !== FLYING) this.life[i] = params.insectBodyTime * (0.7 + Math.random() * 0.6)
        continue
      }

      if (state !== FLYING) {
        // Resting: on the water now and then a twitch (a hop of a pixel and a ripple).
        if (state === ON_WATER && Math.random() < dt * 0.4) {
          data[o] += (Math.random() - 0.5) * 2
          data[o + 1] += (Math.random() - 0.5) * 2
          this.ripple(data[o], data[o + 1])
        }
        this.timer[i] -= dt
        if (this.timer[i] <= 0) {
          if (state === ON_WATER) this.ripple(data[o], data[o + 1]) // take-off
          data[o + 3] = FLYING
          data[o + 2] = 1
        }
        continue
      }

      let x = data[o]
      let y = data[o + 1]
      let z = data[o + 2]
      const h = home[i]
      // A dragonfly close by: drop everything and fly away from it, flat out.
      const flee = this.predators?.fleeFrom(x, y, FLEE_NEAR + FLEE_FAR * genes[gi + G.vigilance])
      if (flee) {
        this.action[i] = NONE
        energy[i] -= hunger * (FLEE_COST - 1) * (0.3 + 0.7 * (speed / CRUISE) ** 2) * dt
      }
      const action = this.action[i]
      let ax
      let ay
      let tz
      if (flee) {
        ax = flee[0] * FLEE_ACCEL
        ay = flee[1] * FLEE_ACCEL
        tz = z
      } else if (action !== NONE) {
        // Heading to land or lay: straight there, skimming low when laying.
        const tx = target[v]
        const ty = target[v + 1]
        ax = (tx - x) * 18 - vel[v] * 4
        ay = (ty - y) * 18 - vel[v + 1] * 4
        tz = action === LANDING || Math.hypot(tx - x, ty - y) < 3 ? 0 : 3
      } else {
        // The dance: a weak pull home, the swarm, random buzz and drag.
        const [hx, hy] = h >= 0 ? this.spotAt(h) : [x, y]
        ax = (hx - x) * HOME_PULL - vel[v] * DRAG + (Math.random() - 0.5) * buzz
        ay = (hy - y) * HOME_PULL - vel[v + 1] * DRAG + (Math.random() - 0.5) * buzz
        tz = (6 + 5 * Math.sin(this.time * 2 + data[o + 4] * 40)) * lowness
        const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / NEIGHBOUR_RADIUS)))
        const cy = Math.min(gh - 1, Math.max(0, Math.floor(y / NEIGHBOUR_RADIUS)))
        let n = 0
        let sx = 0
        let sy = 0
        let px = 0
        let py = 0
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1) && n < MAX_NEIGHBOURS; gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1) && n < MAX_NEIGHBOURS; gx++) {
            const c = gy * gw + gx
            for (let k = start[c]; k < start[c + 1] && n < MAX_NEIGHBOURS; k++) {
              const j = items[k]
              if (j === i) continue
              const dx = data[j * INSECT_STRIDE] - x
              const dy = data[j * INSECT_STRIDE + 1] - y
              const d2 = dx * dx + dy * dy
              if (d2 > NEIGHBOUR_RADIUS * NEIGHBOUR_RADIUS) continue
              n++
              sx += dx
              sy += dy
              if (d2 < SEPARATION * SEPARATION && d2 > 1e-4) {
                // Away from it, harder the closer it is.
                const d = Math.sqrt(d2)
                const push = 1 - d / SEPARATION
                px -= (dx / d) * push
                py -= (dy / d) * push
              }
            }
          }
        }
        if (n > 0) {
          const cohesion = COHESION * genes[gi + G.cohesion]
          const separation = SEPARATION_PUSH * genes[gi + G.separation]
          ax += (sx / n) * cohesion + px * separation
          ay += (sy / n) * cohesion + py * separation
        }
      }
      vel[v] += ax * dt
      vel[v + 1] += ay * dt
      const sp = Math.hypot(vel[v], vel[v + 1])
      const cap = action !== NONE ? speed * 0.5 : speed
      if (sp > cap) {
        vel[v] *= cap / sp
        vel[v + 1] *= cap / sp
      }
      // The wind carries the dancers, less in the lee of plants and trunks;
      // one heading somewhere to land or lay holds its course.
      const exposed = action !== NONE ? 0 : 1 - this.shelterAt(x - wind[0] * 0.5, y - wind[1] * 0.5)
      x += (vel[v] + wind[0] * exposed) * dt
      y += (vel[v + 1] + wind[1] * exposed) * dt
      z += (tz - z) * Math.min(1, dt * (action !== NONE ? 5 : 2))
      data[o] = Math.min(Math.max(x, 0), map.width)
      data[o + 1] = Math.min(Math.max(y, 0), map.height)
      data[o + 2] = z

      if (action !== NONE) {
        const tx = target[v]
        const ty = target[v + 1]
        if (Math.hypot(tx - x, ty - y) < 1.5 && z < 0.6) {
          vel[v] = vel[v + 1] = 0
          this.action[i] = NONE
          if (action === LANDING) {
            // Touch down.
            data[o] = tx
            data[o + 1] = ty
            data[o + 2] = 0
            data[o + 3] = this.onFlower[i] ? ON_FLOWER : ON_WATER
            if (!this.onFlower[i]) this.ripple(tx, ty)
            // One come to drink leaves once it is full; others rest a while.
            const rest = genes[gi + G.rest] * (1 + 2 * genes[gi + G.sunShy] * this.sunAt(tx, ty))
            this.timer[i] = this.feed[i] >= 0 && energy[i] < genes[gi + G.hungry] ? 0.2 : rest * (0.5 + Math.random())
          } else {
            // One dip: a ripple and the raft (as many eggs as she can afford), then back up.
            const brood = Math.min(Math.round(genes[gi + G.brood]), Math.floor((energy[i] - EGG_RESERVE) / EGG_ENERGY))
            this.ripple(tx, ty)
            if (brood >= 1 && this.layEggs(tx, ty, i, brood, params)) {
              energy[i] -= EGG_ENERGY * brood
              this.laid[i] += brood
            }
            data[o + 2] = 2.5
          }
        }
        continue
      }
      if (Math.random() >= pDecide) continue
      const range = genes[gi + G.range]
      if (energy[i] < genes[gi + G.hungry]) {
        // Hungry: to the nearest flower with nectar in range, else move on.
        const f = this.flowerNear(x, y, range)
        if (f >= 0) {
          ;[target[v], target[v + 1]] = this.spotAt(f)
          this.onFlower[i] = 1
          this.feed[i] = f
          this.action[i] = LANDING
        } else home[i] = this.pickHome(i, x, y)
        continue
      }
      // Time to do something else. Rates are per second, decisions every DECIDE s.
      const u = Math.random() / DECIDE
      // A home out in the sun is left sooner.
      const shade = genes[gi + G.shade]
      const restless = h >= 0 ? shade * 0.5 * this.sunAt(...this.spotAt(h)) : 0
      const wander = genes[gi + G.wander] + restless
      // Out in the sun a sun-shy midge would rather sit it out on the water.
      const sunny = genes[gi + G.sunShy] * this.sunAt(x, y)
      const laying = genes[gi + G.laying] * (1 - 0.5 * sunny)
      const landing = genes[gi + G.landing] + 0.5 * sunny
      if (u < wander) {
        home[i] = this.pickHome(i, x, y)
      } else if (u < wander + laying) {
        // Only a well-fed midge has eggs to lay.
        if (energy[i] < genes[gi + G.eggEnergy]) continue
        const [hx, hy] = h >= 0 ? this.spotAt(h) : [x, y]
        const spot = this.nurseryNear(hx, hy)
        if (!spot) continue
        target[v] = spot[0]
        target[v + 1] = spot[1]
        this.action[i] = LAYING
      } else if (u < wander + laying + landing && h >= 0) {
        // Land: on the flower itself, or on the water near home (scum: on the mat).
        const [hx, hy] = this.spotAt(h)
        const flower = this.spotKinds[h] !== SCUM && Math.random() < 0.5
        const spot = flower ? [hx, hy] : this.spotKinds[h] === SCUM ? this.openWaterNear(hx, hy, 0, 6) : this.openWaterNear(hx, hy, 8, 33)
        if (!spot) continue
        target[v] = spot[0]
        target[v + 1] = spot[1]
        this.onFlower[i] = flower ? 1 : 0
        // Perched on a flower it sips whatever is there.
        this.feed[i] = flower ? h : -1
        this.action[i] = LANDING
      }
    }
    this.alive = alive
    const eggs = this.updateEggs(dt, params, alive)
    // Died out (after there were some): they stay gone until spawned again; counted once.
    const present = alive > 0 || eggs > 0
    if (!present && this.present) {
      this.extinctions++
      this.extinct = true
    }
    if (present) this.extinct = false
    this.present = present
    // Ripples spread and fade.
    for (let r = 0; r < RIPPLES; r++) {
      const o = (this.capacity + this.eggSlots + r) * INSECT_STRIDE
      if (data[o + 3] !== RIPPLE) continue
      data[o + 5] += dt
      if (data[o + 5] > RIPPLE_LIFE) data[o + 3] = EMPTY
    }
    this.historyClock -= dt
    if (this.historyClock <= 0) {
      this.historyClock = HISTORY_TICK
      this.history.push([this.time, alive])
      if (this.history.length > HISTORY_LENGTH) this.history.shift()
    }
    this.markSelected()
    this.version++
  }

  /**
   * Somewhere to lay near (x, y): on the water at the rim of a lily pad, or
   * on a scum mat. The nearest of a few random ones within LAY_REACH, or null.
   */
  nurseryNear(x, y) {
    const pads = this.padSpots
    const scum = this.scumSpots
    const nPads = pads.length / 3
    const nScum = scum.length / 2
    let best = null
    let bestD = LAY_REACH
    for (let k = 0; k < 8; k++) {
      let px
      let py
      if (k % 2 === 0 && nPads) {
        const p = Math.floor(Math.random() * nPads) * 3
        const a = Math.random() * Math.PI * 2
        px = pads[p] + Math.cos(a) * (pads[p + 2] + 1.5)
        py = pads[p + 1] + Math.sin(a) * (pads[p + 2] + 1.5)
      } else if (nScum) {
        const s = Math.floor(Math.random() * nScum) * 2
        px = scum[s] + (Math.random() - 0.5) * 6
        py = scum[s + 1] + (Math.random() - 0.5) * 6
      } else continue
      const d = Math.hypot(px - x, py - y)
      if (d < bestD && this.map.distanceAt(px, py) >= 2) {
        bestD = d
        best = [px, py]
      }
    }
    return best
  }

  /** A point on the water between `near` and `far` px from (x, y), clear of plants if `clear`, or null. */
  openWaterNear(x, y, near, far, clear = false) {
    for (let k = 0; k < (clear ? 12 : 8); k++) {
      const a = Math.random() * Math.PI * 2
      const d = near + Math.random() * (far - near)
      const px = x + Math.cos(a) * d
      const py = y + Math.sin(a) * d
      if (this.map.distanceAt(px, py) >= 3 && (!clear || this.shelterAt(px, py) < 0.25)) return [px, py]
    }
    return null
  }

  /** A raft of `brood` eggs from midge i (data[7] carries the count); false if there is no room. */
  layEggs(x, y, i, brood, params) {
    for (let e = 0; e < this.eggSlots; e++) {
      const o = (this.capacity + e) * INSECT_STRIDE
      if (this.data[o + 3] !== EMPTY) continue
      this.data[o] = x
      this.data[o + 1] = y
      this.data[o + 2] = 0
      this.data[o + 3] = EGGS
      this.data[o + 4] = Math.random()
      this.data[o + 5] = params.insectHatch * (0.7 + Math.random() * 0.6) // seconds to hatching
      this.data[o + 6] = 0
      this.data[o + 7] = brood
      this.eggGenes.set(this.genes.subarray(i * NG, (i + 1) * NG), e * NG)
      this.eggGeneration[e] = this.generation[i] + 1
      this.eggMother[e] = this.ids[i]
      return true
    }
    return false
  }

  /**
   * Rafts ripen (data[6] 0 -> 1) and hatch into free slots, each hatchling
   * with its own mutation of the mother's genome; with no slot free they just
   * fail. Returns the rafts still ripening.
   */
  updateEggs(dt, params, alive) {
    const data = this.data
    let free = this.capacity - alive
    let slot = 0
    let waiting = 0
    const locked = this.lockedProfile ? objectToGenome(this.lockedProfile.genes) : null
    for (let e = 0; e < this.eggSlots; e++) {
      const o = (this.capacity + e) * INSECT_STRIDE
      if (data[o + 3] !== EGGS) continue
      data[o + 6] += dt / data[o + 5]
      if (data[o + 6] < 1) {
        waiting++
        continue
      }
      data[o + 3] = EMPTY
      this.ripple(data[o], data[o + 1])
      const mother = this.slotOf(this.eggMother[e])
      const parent = this.eggGenes.subarray(e * NG, (e + 1) * NG)
      for (let k = 0; k < data[o + 7] && free > 0; k++) {
        while (slot < this.capacity && data[slot * INSECT_STRIDE + 3] !== EMPTY) slot++
        if (slot >= this.capacity) break
        const genome = locked ?? this.mutate(Array.from(parent), params)
        this.spawn(slot, data[o], data[o + 1], 0.5, genome, this.eggGeneration[e], this.eggMother[e], params, EGG_ENERGY)
        if (mother >= 0) this.children[mother]++
        free--
      }
    }
    return waiting
  }

  /** The slot of the living midge with this id, or -1. */
  slotOf(id) {
    if (!id) return -1
    for (let i = 0; i < this.capacity; i++) if (this.ids[i] === id && this.isAdult(i)) return i
    return -1
  }

  /** Other midges flying within `r` px of midge i (r up to NEIGHBOUR_RADIUS; from this frame's grid). */
  flyingNear(i, r) {
    const { start, items, w, h } = this.grid
    if (!start) return 0
    const data = this.data
    const x = data[i * INSECT_STRIDE]
    const y = data[i * INSECT_STRIDE + 1]
    const cx = Math.min(w - 1, Math.max(0, Math.floor(x / NEIGHBOUR_RADIUS)))
    const cy = Math.min(h - 1, Math.max(0, Math.floor(y / NEIGHBOUR_RADIUS)))
    let n = 0
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(h - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(w - 1, cx + 1); gx++) {
        const c = gy * w + gx
        for (let k = start[c]; k < start[c + 1]; k++) {
          const j = items[k]
          if (j === i || data[j * INSECT_STRIDE + 3] !== FLYING) continue
          if ((data[j * INSECT_STRIDE] - x) ** 2 + (data[j * INSECT_STRIDE + 1] - y) ** 2 < r * r) n++
        }
      }
    }
    return n
  }

  /** A predator caught midge i: gone without a trace. */
  eaten(i) {
    this.data[i * INSECT_STRIDE + 3] = EMPTY
    this.deaths.eaten++
  }

  /** Select the living midge nearest (x, y) within `maxDist` px (or none); returns whether one was found. */
  select(x, y, maxDist = 10) {
    let best = -1
    let bestD2 = maxDist * maxDist
    for (let i = 0; i < this.capacity; i++) {
      if (!this.isAdult(i)) continue
      const d2 = (this.data[i * INSECT_STRIDE] - x) ** 2 + (this.data[i * INSECT_STRIDE + 1] - y) ** 2
      if (d2 < bestD2) {
        bestD2 = d2
        best = i
      }
    }
    this.selectedId = best >= 0 ? this.ids[best] : 0
    this.markSelected()
    return best >= 0
  }

  /** Flag the selected midge for the renderer (data[7] of a midge; rafts use it for their brood). */
  markSelected() {
    const s = this.slotOf(this.selectedId)
    for (let i = 0; i < this.capacity; i++) this.data[i * INSECT_STRIDE + 7] = i === s ? 1 : 0
    this.version++
  }

  /** The selected midge, for the panel, or null (none, or it died). */
  selectedInfo() {
    const i = this.slotOf(this.selectedId)
    if (i < 0) return null
    const state = this.data[i * INSECT_STRIDE + 3]
    return {
      id: this.ids[i],
      generation: this.generation[i],
      age: this.age[i],
      life: this.life[i],
      energy: this.energy[i],
      doing: state === ON_FLOWER ? (this.feed[i] >= 0 && this.energy[i] < 0.98 ? 'drinking' : 'perched') : state === ON_WATER ? 'resting' : this.action[i] === LAYING ? 'going to lay' : this.action[i] === LANDING ? 'landing' : 'dancing',
      children: this.children[i],
      laid: this.laid[i],
      genes: genomeToObject(this.genes.subarray(i * NG, (i + 1) * NG)),
    }
  }

  /** Mean and spread of each gene over the living midges, as a profile's `genes` / `spread`. */
  population() {
    const sum = new Float64Array(NG)
    const sq = new Float64Array(NG)
    let n = 0
    let gen = 0
    let maxGen = 0
    for (let i = 0; i < this.capacity; i++) {
      if (!this.isAdult(i)) continue
      n++
      gen += this.generation[i]
      maxGen = Math.max(maxGen, this.generation[i])
      for (let k = 0; k < NG; k++) {
        const v = this.genes[i * NG + k]
        sum[k] += v
        sq[k] += v * v
      }
    }
    if (!n) return null
    const mean = Array.from(sum, (s) => s / n)
    const spread = mean.map((m, k) => Math.sqrt(Math.max(0, sq[k] / n - m * m)))
    return { count: n, generation: gen / n, maxGeneration: maxGen, genes: genomeToObject(mean), spread: genomeToObject(spread) }
  }

  /** For the panel: population, eggs, swarms (spots with 3+ midges), dry flowers, history. */
  stats() {
    let eggs = 0
    for (let e = 0; e < this.eggSlots; e++) if (this.data[(this.capacity + e) * INSECT_STRIDE + 3] === EGGS) eggs++
    const perSpot = new Map()
    for (let i = 0; i < this.capacity; i++) if (this.isAdult(i) && this.home[i] >= 0) perSpot.set(this.home[i], (perSpot.get(this.home[i]) ?? 0) + 1)
    let swarms = 0
    for (const n of perSpot.values()) if (n >= 3) swarms++
    let dry = 0
    let resting = 0
    for (let f = 0; f < this.flowerCount; f++) {
      const p = this.flowerPlant[f]
      if (this.dormant[p] > 0) resting++
      else if (this.closed[p]) dry++
    }
    return {
      resting,
      deaths: { ...this.deaths },
      alive: this.alive,
      eggs,
      swarms,
      dry,
      flowers: this.flowerCount,
      time: this.time,
      extinctions: this.extinctions,
      extinct: Boolean(this.extinct),
      history: this.history.slice(),
      population: this.population(),
      selected: this.selectedInfo(),
    }
  }
}
