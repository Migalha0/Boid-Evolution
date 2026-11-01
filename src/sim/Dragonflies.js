import { genomeToObject, mutate, objectToGenome, randomGenome, summarize } from './genetics.js'
import { DRAGONFLY, DRAGON_EGGS, EMPTY as EMPTY_POINT, FLYING as MIDGE_FLYING, INSECT_STRIDE } from './Insects.js'

/**
 * Dragonfly slots (and as many for clutches of eggs) to start with; they
 * double when needed, up to `dragonflyCap` (Infinity: no limit).
 */
export const DRAGON_SLOTS = 128

/**
 * The dragonfly genome: how it hunts, rests and breeds, and its body colour
 * (no use but to tell lineages apart: it only drifts).
 */
export const DRAGON_GENES = [
  { key: 'speed', label: 'Top speed', min: 80, max: 240, unit: ' px/s', hint: 'flying fast costs more energy' },
  { key: 'agility', label: 'Agility', min: 150, max: 900, unit: ' px/s²', hint: 'how hard it can turn' },
  { key: 'sight', label: 'Sight', min: 40, max: 250, unit: ' px', hint: 'how far it spots a flying midge' },
  { key: 'patience', label: 'Chases for', min: 0.5, max: 5, unit: ' s' },
  { key: 'digest', label: 'Digests in', min: 0.5, max: 2.5, unit: ' s', hint: 'quick digesters hunt again sooner but get less from a midge (0.6x the energy at the quickest, 1.4x at the slowest)' },
  { key: 'confusion', label: 'Swarm confusion', min: 0, max: 0.28, unit: '', hint: 'each flying midge near its prey divides its strike chance by 1 + this; steadier hunters see less far (0.6x sight at 0)' },
  { key: 'ambush', label: 'Ambushes', min: 0, max: 1, unit: '', hint: 'hungry, how often it waits on a perch for midges to pass (resting is cheap, but fewer come by) instead of patrolling' },
  { key: 'territory', label: 'Territorial', min: 0, max: 1, unit: '', hint: 'chases rivals out of up to 180 px around it when not hunting (flying flat out costs energy)' },
  { key: 'huntBelow', label: 'Hunts below', min: 0.3, max: 1, unit: '', hint: 'energy below which it hunts; above, it perches or patrols' },
  { key: 'perch', label: 'Perches for', min: 1, max: 30, unit: ' s' },
  { key: 'laying', label: 'Lays', min: 0, max: 0.1, unit: ' /s' },
  { key: 'eggEnergy', label: 'Lays above', min: 0.3, max: 1, unit: '', hint: 'energy it needs to lay' },
  { key: 'brood', label: 'Eggs per clutch', min: 1, max: 4, unit: '', hint: 'each egg takes 0.3 energy from the mother; its dragonfly gets up to all of it' },
  { key: 'lifespan', label: 'Lifespan', min: 120, max: 400, unit: ' s', hint: 'a longer life, but no eggs until a fifth of the way through it' },
  { key: 'hatch', label: 'Eggs emerge after', min: 30, max: 150, unit: ' s', hint: 'quick eggs give weaker dragonflies (half the egg energy at the quickest); slow ones are lost more often' },
  { key: 'red', label: 'Red', min: 0, max: 1, unit: '' },
  { key: 'green', label: 'Green', min: 0, max: 1, unit: '' },
  { key: 'blue', label: 'Blue', min: 0, max: 1, unit: '' },
]
const NG = DRAGON_GENES.length
const G = Object.fromEntries(DRAGON_GENES.map((g, k) => [g.key, k]))

/** Dragonfly genomes as { key: value } and back (see genetics.js). */
export const dragonGenomeToObject = (genome) => genomeToObject(DRAGON_GENES, genome)
export const objectToDragonGenome = (obj) => objectToGenome(DRAGON_GENES, obj)

/** What a dragonfly is doing. */
const EMPTY = 0
const FLYING = 1
const PERCHED = 2
/** What it is flying towards when not hunting. */
const PATROL = 0
const TO_PERCH = 1
const TO_LAY = 2

/**
 * A strike lands with this chance, less among other flying midges (each
 * within CONFUSE_RADIUS px of the prey divides it by 1 + its confusion
 * gene). A catch gives `dragonflyMeal` energy, scaled by how long it takes
 * to digest (its digest gene): 0.6x at the quickest to 1.4x at the slowest.
 */
const STRIKE = 0.7
const CONFUSE_RADIUS = 12
/** Hungry on a perch, an ambusher waits up to AMBUSH_WAIT * its gene s, striking at midges within AMBUSH_SIGHT of its sight. */
const AMBUSH_WAIT = 20
const AMBUSH_SIGHT = 0.6
/** The territory gene's radius at its top (px), and how hard a rival is pushed out of it. */
const TERRITORY = 180
const EVICT_PUSH = 500
/** Cold-blooded: in full shade a dragonfly flies at most (1 - SHADE_SLOW) of its top speed. */
const SHADE_SLOW = 0.4
/** Flight cost: `dragonflyHunger` per s at CRUISE px/s, growing with speed squared; perched, REST of it. */
const CRUISE = 130
const REST = 0.15
/**
 * Energy a mother puts into each egg, and all the dragonfly that emerges
 * starts with (energy is only passed on, never made: it all comes from
 * midges). She lays only as many eggs as she can afford (keeping EGG_RESERVE).
 */
const EGG_ENERGY = 0.3
const EGG_RESERVE = 0.05
/** Life-history trades, as for midges: lays only after MATURE of its lifespan; clutches lost with chance EGG_LOSS per s. */
const MATURE = 0.2
const EGG_LOSS = 0.003
/** Dragonflies keep this far apart (px) and push each other off (territory). */
const SPACING = 30
/** Seconds between population samples, and how many are kept. */
const HISTORY_TICK = 2
const HISTORY_LENGTH = 300

const pack = (r, g, b) => Math.floor(r * 255) * 65536 + Math.floor(g * 255) * 256 + Math.floor(b * 255)

/**
 * Dragonflies: the midges' predators, a species of their own with its own
 * genome, life cycle and point buffer (drawn by the same point shader as the
 * midges, as DRAGONFLY points). Their one link to the midges is the hunt: they
 * read the midges' positions (Insects) and eat them; the midges flee them
 * (Insects asks fleeFrom).
 *
 * A dragonfly burns energy flying (more the faster it actually flies) and
 * only gains it by eating midges. Hungry (below its `huntBelow` gene) it
 * hunts: it chases the nearest flying midge it can see, for up to its
 * `patience`, and strikes on catching up; a midge flees at its own top speed,
 * so the faster midges get away. The digest gene trades how much a midge
 * gives against how long it takes to digest; the confusion gene trades
 * steadiness in a swarm against sight; the ambush gene has it wait on a
 * perch for prey (cheap, but fewer pass) instead of patrolling; the territory
 * gene has it chase rivals away when it isn't hunting. It is slower in the
 * shade (cold-blooded), and a strike misses more often in a crowd of flying
 * midges. Fed, it patrols, perches on a plant to rest,
 * or, above its `eggEnergy`, flies to the water among the plants to lay a
 * clutch, once a fifth of its lifespan gene is past. The eggs hatch after its hatch gene (nymphs emerging) into
 * dragonflies carrying the mother's genes, each mutated
 * (`dragonflyMutationRate` / `dragonflyMutationSize`), up to `dragonflyCap`
 * (Infinity: no limit). The clutches show on the water, darkening as they
 * ripen.
 * So their numbers follow the midges' with a delay. The first
 * `dragonflyStart` arrive with random genes only when restart() is called
 * (the user's spawn button); if they die out they stay gone. With `dragonflyLocked` and a `dragonflyProfile`, every dragonfly
 * carries the profile's genome exactly.
 */
export class Dragonflies {
  /** @param insects the midges they hunt (and whose world, plants and water they share) */
  constructor(insects) {
    this.insects = insects
    this.slots = 0
    this.allocate(DRAGON_SLOTS)
    this.nextId = 1
    this.alive = 0
    this.clutches = 0
    this.deaths = { aged: 0, starved: 0 }
    this.extinctions = 0
    this.present = false // any dragonflies or clutches (so dying out can be told from never spawned)
    this.extinct = false
    this.time = 0
    this.history = []
    this.historyClock = 0
    this.selectedId = 0
    this.lockedProfile = null
    this.midgeCapacity = 0
  }

  /**
   * Room for `n` dragonflies and `n` clutches, keeping everyone. Per
   * dragonfly: state, position, velocity, height, heading, energy, age and
   * lifespan, genes, generation, id, kills, offspring; hunting: its prey (a
   * midge slot, -1 none), seconds into the chase, the last that got away,
   * seconds to the next look, seconds left eating; otherwise where it is
   * going (PATROL / TO_PERCH / TO_LAY), the point and a timer. Per clutch:
   * eggs, position, seconds left (of how many), the mother's genes /
   * generation / id. Points for the renderer: dragonflies, then clutches.
   */
  allocate(n) {
    const old = this.slots
    const grow = (a, w, Type = Float32Array) => {
      const b = new Type(n * w)
      if (a) b.set(a.subarray(0, Math.min(a.length, n * w)))
      return b
    }
    this.state = grow(this.state, 1, Uint8Array)
    this.pos = grow(this.pos, 2)
    this.vel = grow(this.vel, 2)
    this.z = grow(this.z, 1)
    this.heading = grow(this.heading, 1)
    this.energy = grow(this.energy, 1)
    this.age = grow(this.age, 1)
    this.life = grow(this.life, 1)
    this.genes = grow(this.genes, NG)
    this.generation = grow(this.generation, 1)
    this.ids = grow(this.ids, 1, Uint32Array)
    this.kills = grow(this.kills, 1)
    this.children = grow(this.children, 1)
    this.prey = grow(this.prey, 1, Int32Array)
    this.chase = grow(this.chase, 1)
    this.spared = grow(this.spared, 1, Int32Array)
    this.look = grow(this.look, 1)
    this.eating = grow(this.eating, 1)
    this.goal = grow(this.goal, 1, Uint8Array)
    this.target = grow(this.target, 2)
    this.timer = grow(this.timer, 1)
    this.evicting = grow(this.evicting, 1, Int32Array)
    this.clutchEggs = grow(this.clutchEggs, 1)
    this.clutchPos = grow(this.clutchPos, 2)
    this.clutchTime = grow(this.clutchTime, 1)
    this.clutchTotal = grow(this.clutchTotal, 1)
    this.clutchGenes = grow(this.clutchGenes, NG)
    this.clutchGeneration = grow(this.clutchGeneration, 1)
    this.clutchMother = grow(this.clutchMother, 1, Uint32Array)
    for (let d = old; d < n; d++) {
      this.prey[d] = -1
      this.spared[d] = -1
      this.evicting[d] = -1
    }
    this.data = new Float32Array(2 * n * INSECT_STRIDE)
    this.points = 2 * n
    this.slots = n
    this.writePoints()
  }

  /** A free dragonfly slot, growing (up to the cap) if there is none; -1 if full. */
  freeSlot(params) {
    for (let d = 0; d < this.slots; d++) if (this.state[d] === EMPTY) return d
    if (this.slots >= params.dragonflyCap) return -1
    const d = this.slots
    this.allocate(this.slots * 2)
    return d
  }

  /** Newcomers: random genes, or the locked / given profile's; spread over the pond. */
  seed(params, profile = params.dragonflyLocked ? params.dragonflyProfile : null) {
    const map = this.insects.map
    const genome = profile ? objectToDragonGenome(profile.genes) : null
    const n = Math.min(params.dragonflyCap, Math.round(params.dragonflyStart))
    for (let placed = 0; placed < n; placed++) {
      const d = this.freeSlot(params)
      if (d < 0) break
      const g = genome ? (params.dragonflyLocked ? genome : this.mutate(genome, params)) : randomGenome(DRAGON_GENES)
      this.spawn(d, Math.random() * map.width, Math.random() * map.height, g, 0, params, 0.7)
      this.age[d] = Math.random() * this.life[d] * 0.3
    }
  }

  /** Start over: everyone and every clutch gone; a fresh flock (or the profile's) arrives at once. */
  restart(params, profile = null) {
    this.state.fill(EMPTY)
    this.clutchEggs.fill(0)
    this.alive = 0
    this.seed(params, profile ?? (params.dragonflyLocked ? params.dragonflyProfile : null))
  }

  mutate(genome, params) {
    return mutate(DRAGON_GENES, genome, params.dragonflyMutationRate, params.dragonflyMutationSize)
  }

  spawn(d, x, y, genome, generation, params, energy) {
    this.state[d] = FLYING
    this.pos[d * 2] = x
    this.pos[d * 2 + 1] = y
    this.vel[d * 2] = this.vel[d * 2 + 1] = 0
    this.z[d] = 2
    this.energy[d] = energy
    this.age[d] = 0
    this.life[d] = genome[G.lifespan] * (0.9 + Math.random() * 0.2)
    this.genes.set(genome, d * NG)
    this.generation[d] = generation
    this.ids[d] = this.nextId++
    this.kills[d] = 0
    this.children[d] = 0
    this.prey[d] = -1
    this.spared[d] = -1
    this.eating[d] = 0
    this.goal[d] = PATROL
    this.timer[d] = 0
    this.evicting[d] = -1
  }

  /** Every living dragonfly (and every clutch) takes the profile's genome. */
  applyProfile(profile) {
    const genome = objectToDragonGenome(profile.genes)
    for (let d = 0; d < this.slots; d++) if (this.state[d] !== EMPTY) this.genes.set(genome, d * NG)
    for (let c = 0; c < this.slots; c++) this.clutchGenes.set(genome, c * NG)
  }

  /** Lock to (or unlock from) a profile: while locked everyone carries it and nothing mutates. */
  syncLock(params) {
    const profile = params.dragonflyLocked ? params.dragonflyProfile : null
    if (profile === this.lockedProfile) return
    this.lockedProfile = profile
    if (profile) this.applyProfile(profile)
  }

  /**
   * Note where the hunting dragonflies are, for fleeFrom (Insects calls this
   * before its midges move; the dragonflies don't move until it is done).
   */
  prepare() {
    if (!this.hunters || this.hunters.length < this.slots * 2) this.hunters = new Float32Array(this.slots * 2)
    let n = 0
    for (let d = 0; d < this.slots; d++) {
      if (this.state[d] !== FLYING || this.prey[d] < 0) continue
      this.hunters[n * 2] = this.pos[d * 2]
      this.hunters[n * 2 + 1] = this.pos[d * 2 + 1]
      n++
    }
    this.hunterCount = n
  }

  /** Unit vector away from the hunting dragonflies within `radius` of (x, y), or null (Insects asks, after prepare()). */
  fleeFrom(x, y, radius) {
    if (!this.hunterCount) return null
    let fx = 0
    let fy = 0
    const r2 = radius * radius
    const h = this.hunters
    for (let n = 0; n < this.hunterCount; n++) {
      const dx = x - h[n * 2]
      const dy = y - h[n * 2 + 1]
      const d2 = dx * dx + dy * dy
      if (d2 > r2 || d2 < 1e-6) continue
      const k = 1 / Math.sqrt(d2)
      fx += dx * k
      fy += dy * k
    }
    const len = Math.hypot(fx, fy)
    return len > 0 ? [fx / len, fy / len] : null
  }

  /**
   * @param params dragonflyCap / dragonflyStart, dragonflyHunger (energy burnt
   *   per s at 130 px/s), dragonflyMeal (energy per midge),
   *   dragonflyMutationRate / dragonflyMutationSize, dragonflyProfile /
   *   dragonflyLocked. The rest of how a dragonfly behaves is in its genes.
   */
  update(dt, params) {
    const ins = this.insects
    const md = ins.data // the midges
    const S = INSECT_STRIDE
    const map = ins.map
    this.time += dt
    this.syncLock(params)
    // The midges' slots moved (their cap changed): forget who was who.
    if (ins.capacity !== this.midgeCapacity) {
      this.midgeCapacity = ins.capacity
      this.prey.fill(-1)
      this.spared.fill(-1)
    }
    const hunger = params.dragonflyHunger
    // Who is about (in slot order), so the loops skip the empty slots.
    if (!this.live || this.live.length < this.slots) this.live = new Int32Array(this.slots)
    const live = this.live
    let nLive = 0
    for (let d = 0; d < this.slots; d++) if (this.state[d] !== EMPTY) live[nLive++] = d
    this.liveCount = nLive
    let alive = 0
    for (let l = 0; l < nLive; l++) {
      const d = live[l]
      if (this.state[d] === EMPTY) continue
      const v = d * 2
      const gi = d * NG
      const genes = this.genes
      this.age[d] += dt
      const speedNow = Math.hypot(this.vel[v], this.vel[v + 1])
      this.energy[d] -= hunger * (this.state[d] === PERCHED ? REST : 0.3 + 0.7 * (speedNow / CRUISE) ** 2) * dt
      if (this.age[d] > this.life[d] || this.energy[d] <= 0) {
        if (this.energy[d] <= 0) this.deaths.starved++
        else this.deaths.aged++
        this.state[d] = EMPTY
        continue
      }
      alive++
      let x = this.pos[v]
      let y = this.pos[v + 1]
      const hungry = this.energy[d] < genes[gi + G.huntBelow]
      // Steadier in a swarm, shorter-sighted.
      const sight = genes[gi + G.sight] * (0.6 + (0.4 * genes[gi + G.confusion]) / DRAGON_GENES[G.confusion].max)

      if (this.state[d] === PERCHED) {
        // Resting on a plant until rested; hungry, it waits in ambush as long
        // as its gene says (0: off at once), striking at midges passing close.
        if (hungry) this.timer[d] = Math.min(this.timer[d], genes[gi + G.ambush] * AMBUSH_WAIT)
        this.timer[d] -= dt
        if (this.eating[d] > 0) this.eating[d] -= dt
        let prey = -1
        if (hungry && this.eating[d] <= 0) {
          this.look[d] -= dt
          if (this.look[d] <= 0) {
            this.look[d] = 0.3
            prey = this.nearestMidge(x, y, sight * AMBUSH_SIGHT, -1)
          }
        }
        if (this.timer[d] <= 0 || prey >= 0) {
          this.state[d] = FLYING
          this.goal[d] = PATROL
          this.timer[d] = 0
          this.prey[d] = prey
          this.chase[d] = 0
        }
        continue
      }

      if (this.eating[d] > 0) this.eating[d] -= dt
      let prey = this.prey[d]
      if (hungry && this.eating[d] <= 0) {
        // Lose prey that landed, died or got too far, or a chase that went on too long.
        if (prey >= 0) {
          this.chase[d] += dt
          const po = prey * S
          if (this.chase[d] > genes[gi + G.patience]) {
            this.spared[d] = prey
            this.look[d] = 0.5
            prey = -1
          } else if (md[po + 3] !== MIDGE_FLYING || Math.hypot(md[po] - x, md[po + 1] - y) > sight * 1.3) prey = -1
        }
        this.look[d] -= dt
        if (prey < 0 && this.look[d] <= 0) {
          this.look[d] = 0.3
          this.chase[d] = 0
          prey = this.nearestMidge(x, y, sight, this.spared[d])
        }
      } else prey = -1
      this.prey[d] = prey

      // Slower in the shade.
      const top = genes[gi + G.speed] * (1 - SHADE_SLOW * (1 - ins.sunAt(x, y)))
      // Not hunting: a rival inside its territory is chased off.
      this.evicting[d] = prey < 0 && this.goal[d] !== TO_LAY ? this.rivalWithin(d, x, y, genes[gi + G.territory] * TERRITORY) : -1
      const rival = this.evicting[d]
      let tx
      let ty
      let speed
      if (prey >= 0) {
        // Aim a little ahead of it.
        tx = md[prey * S] + ins.vel[prey * 2] * 0.15
        ty = md[prey * S + 1] + ins.vel[prey * 2 + 1] * 0.15
        speed = top
      } else if (rival >= 0) {
        tx = this.pos[rival * 2]
        ty = this.pos[rival * 2 + 1]
        speed = top
      } else {
        this.timer[d] -= dt
        const arrived = Math.hypot(this.target[v] - x, this.target[v + 1] - y) < 4
        if (this.goal[d] === TO_PERCH && arrived) {
          this.state[d] = PERCHED
          this.timer[d] = hungry ? genes[gi + G.ambush] * AMBUSH_WAIT : genes[gi + G.perch] * (0.5 + Math.random())
          this.look[d] = 0
          this.vel[v] = this.vel[v + 1] = 0
          continue
        }
        if (this.goal[d] === TO_LAY && arrived) {
          this.lay(d, x, y, params)
          this.goal[d] = PATROL
          this.timer[d] = 0
        }
        if (this.goal[d] === PATROL && (this.timer[d] <= 0 || arrived)) this.decide(d, x, y, hungry)
        tx = this.target[v]
        ty = this.target[v + 1]
        speed = top * (this.goal[d] === PATROL ? 0.35 : 0.5)
      }

      // Steer for the target at `speed`, turning no harder than its agility;
      // keep off other dragonflies, and out of the territory of any chasing
      // it off.
      const dist = Math.hypot(tx - x, ty - y)
      let ax = ((dist > 1e-3 ? ((tx - x) / dist) * speed : 0) - this.vel[v]) * 4
      let ay = ((dist > 1e-3 ? ((ty - y) / dist) * speed : 0) - this.vel[v + 1]) * 4
      for (let l2 = 0; l2 < nLive; l2++) {
        const e = live[l2]
        if (e === d || this.state[e] !== FLYING) continue
        const dx = x - this.pos[e * 2]
        const dy = y - this.pos[e * 2 + 1]
        const d2 = dx * dx + dy * dy
        if (d2 < 1e-6) continue
        if (this.evicting[e] === d) {
          const k = EVICT_PUSH / Math.sqrt(d2)
          ax += dx * k
          ay += dy * k
        }
        if (d2 > SPACING * SPACING) continue
        const k = ((1 - Math.sqrt(d2) / SPACING) * 600) / Math.sqrt(d2)
        ax += dx * k
        ay += dy * k
      }
      const agility = genes[gi + G.agility]
      const a = Math.hypot(ax, ay)
      if (a > agility) {
        ax *= agility / a
        ay *= agility / a
      }
      this.vel[v] += ax * dt
      this.vel[v + 1] += ay * dt
      const sp = Math.hypot(this.vel[v], this.vel[v + 1])
      if (sp > top) {
        this.vel[v] *= top / sp
        this.vel[v + 1] *= top / sp
      }
      x = Math.min(Math.max(x + this.vel[v] * dt, 0), map.width)
      y = Math.min(Math.max(y + this.vel[v + 1] * dt, 0), map.height)
      this.pos[v] = x
      this.pos[v + 1] = y
      this.z[d] += ((this.goal[d] === TO_LAY && prey < 0 ? 1 : 9) - this.z[d]) * Math.min(1, dt * 2)
      if (sp > 1) this.heading[d] = Math.atan2(this.vel[v + 1], this.vel[v])

      if (prey >= 0) {
        const po = prey * S
        if (Math.hypot(md[po] - x, md[po + 1] - y) < 3) {
          this.prey[d] = -1
          if (Math.random() < STRIKE / (1 + genes[gi + G.confusion] * ins.flyingNear(prey, CONFUSE_RADIUS))) {
            // Caught: eaten on the wing, a while to eat it.
            const digest = genes[gi + G.digest]
            const { min, max } = DRAGON_GENES[G.digest]
            ins.eaten(prey)
            this.energy[d] = Math.min(1, this.energy[d] + params.dragonflyMeal * (0.6 + (0.8 * (digest - min)) / (max - min)))
            this.kills[d]++
            this.eating[d] = digest
          } else {
            this.spared[d] = prey
            this.look[d] = 0.5
          }
        }
      }
    }
    this.alive = alive
    this.updateClutches(dt, params)
    // Died out (after there were some): they stay gone until spawned again; counted once.
    const present = this.alive > 0 || this.clutches > 0
    if (!present && this.present) {
      this.extinctions++
      this.extinct = true
    }
    if (present) this.extinct = false
    this.present = present
    this.historyClock -= dt
    if (this.historyClock <= 0) {
      this.historyClock = HISTORY_TICK
      this.history.push([this.time, this.alive])
      if (this.history.length > HISTORY_LENGTH) this.history.shift()
    }
    this.writePoints()
  }

  /** The nearest flying midge within `range` of (x, y) but `skip`, or -1. */
  nearestMidge(x, y, range, skip) {
    const ins = this.insects
    const md = ins.data
    let best = range * range
    let prey = -1
    for (let i = 0; i < ins.capacity; i++) {
      const io = i * INSECT_STRIDE
      if (md[io + 3] !== MIDGE_FLYING || i === skip) continue
      const d2 = (md[io] - x) ** 2 + (md[io + 1] - y) ** 2
      if (d2 < best) {
        best = d2
        prey = i
      }
    }
    return prey
  }

  /** The nearest other flying dragonfly within `range` of dragonfly d at (x, y), or -1. */
  rivalWithin(d, x, y, range) {
    if (range < SPACING) return -1
    let best = range * range
    let rival = -1
    for (let l = 0; l < this.liveCount; l++) {
      const e = this.live[l]
      if (e === d || this.state[e] !== FLYING) continue
      const d2 = (this.pos[e * 2] - x) ** 2 + (this.pos[e * 2 + 1] - y) ** 2
      if (d2 < best) {
        best = d2
        rival = e
      }
    }
    return rival
  }

  /** Not hunting: lay if well fed and it feels like it, else perch now and then, else patrol. */
  decide(d, x, y, hungry) {
    const ins = this.insects
    const gi = d * NG
    const v = d * 2
    const range = 250
    this.timer[d] = 3 + Math.random() * 4
    if (!hungry && this.energy[d] >= this.genes[gi + G.eggEnergy] && this.age[d] >= MATURE * this.life[d] && Math.random() < this.genes[gi + G.laying] * this.timer[d]) {
      // Into the water among the plants.
      const s = ins.spotWithin(x, y, range)
      const spot = s >= 0 ? ins.openWaterNear(ins.spots[s * 2], ins.spots[s * 2 + 1], 4, 20) : null
      if (spot) {
        this.goal[d] = TO_LAY
        this.target[v] = spot[0]
        this.target[v + 1] = spot[1]
        return
      }
    }
    // Fed, it perches now and then to rest; hungry, an ambusher perches to wait for prey.
    if (hungry ? Math.random() < this.genes[gi + G.ambush] : Math.random() < 0.5) {
      const s = ins.spotWithin(x, y, range)
      if (s >= 0) {
        this.goal[d] = TO_PERCH
        this.target[v] = ins.spots[s * 2]
        this.target[v + 1] = ins.spots[s * 2 + 1]
        return
      }
    }
    this.goal[d] = PATROL
    this.target[v] = Math.min(Math.max(x + (Math.random() - 0.5) * 2 * range, 0), ins.map.width)
    this.target[v + 1] = Math.min(Math.max(y + (Math.random() - 0.5) * 2 * range, 0), ins.map.height)
  }

  lay(d, x, y, params) {
    // As many eggs as she can afford.
    const brood = Math.min(Math.round(this.genes[d * NG + G.brood]), Math.floor((this.energy[d] - EGG_RESERVE) / EGG_ENERGY))
    if (brood < 1) return
    for (let c = 0; c < this.slots; c++) {
      if (this.clutchEggs[c] > 0) continue
      this.clutchEggs[c] = brood
      this.clutchPos[c * 2] = x
      this.clutchPos[c * 2 + 1] = y
      this.clutchTime[c] = this.genes[d * NG + G.hatch] * (0.9 + Math.random() * 0.2)
      this.clutchTotal[c] = this.clutchTime[c]
      this.clutchGenes.set(this.genes.subarray(d * NG, (d + 1) * NG), c * NG)
      this.clutchGeneration[c] = this.generation[d] + 1
      this.clutchMother[c] = this.ids[d]
      this.energy[d] -= EGG_ENERGY * brood
      this.insects.ripple(x, y)
      return
    }
  }

  /** Clutches ripen and hatch into free slots (up to the cap), each nymph mutating its mother's genes. */
  updateClutches(dt, params) {
    let waiting = 0
    let free = params.dragonflyCap - this.alive
    const locked = this.lockedProfile ? objectToDragonGenome(this.lockedProfile.genes) : null
    for (let c = 0; c < this.slots; c++) {
      if (this.clutchEggs[c] <= 0) continue
      if (Math.random() < EGG_LOSS * dt) {
        this.clutchEggs[c] = 0
        continue
      }
      this.clutchTime[c] -= dt
      if (this.clutchTime[c] > 0) {
        waiting++
        continue
      }
      const mother = this.slotOf(this.clutchMother[c])
      const parent = this.clutchGenes.subarray(c * NG, (c + 1) * NG)
      for (let k = 0; k < this.clutchEggs[c] && free > 0; k++) {
        const d = this.freeSlot(params)
        if (d < 0) break
        const x = this.clutchPos[c * 2] + (Math.random() - 0.5) * 10
        const y = this.clutchPos[c * 2 + 1] + (Math.random() - 0.5) * 10
        const strength = 0.5 + (0.5 * this.clutchTotal[c]) / DRAGON_GENES[G.hatch].max
        this.spawn(d, x, y, locked ?? this.mutate(parent, params), this.clutchGeneration[c], params, EGG_ENERGY * strength)
        if (mother >= 0) this.children[mother]++
        free--
        this.alive++
      }
      this.clutchEggs[c] = 0
    }
    this.clutches = waiting
  }

  /** Everyone, then the clutches (ripening 0 -> 1 in data[6]), into the point buffer for the renderer. */
  writePoints() {
    const data = this.data
    for (let c = 0; c < this.slots; c++) {
      const o = (this.slots + c) * INSECT_STRIDE
      if (this.clutchEggs[c] <= 0) {
        data[o + 3] = EMPTY_POINT
        continue
      }
      data[o] = this.clutchPos[c * 2]
      data[o + 1] = this.clutchPos[c * 2 + 1]
      data[o + 2] = 0
      data[o + 3] = DRAGON_EGGS
      data[o + 4] = (c % 89) / 89
      data[o + 5] = 0
      data[o + 6] = 1 - Math.max(0, this.clutchTime[c]) / Math.max(this.clutchTotal[c], 1e-3)
      data[o + 7] = this.clutchEggs[c]
    }
    for (let d = 0; d < this.slots; d++) {
      const o = d * INSECT_STRIDE
      if (this.state[d] === EMPTY) {
        data[o + 3] = EMPTY_POINT
        continue
      }
      const gi = d * NG
      data[o] = this.pos[d * 2]
      data[o + 1] = this.pos[d * 2 + 1]
      data[o + 2] = this.state[d] === PERCHED ? 3 : this.z[d]
      data[o + 3] = DRAGONFLY
      data[o + 4] = (this.ids[d] % 97) / 97
      data[o + 5] = this.heading[d]
      data[o + 6] = pack(this.genes[gi + G.red], this.genes[gi + G.green], this.genes[gi + G.blue])
      // Selected, plus 2 when perched (wings held still).
      data[o + 7] = (this.ids[d] === this.selectedId ? 1 : 0) + (this.state[d] === PERCHED ? 2 : 0)
    }
    this.version++
  }

  slotOf(id) {
    if (!id) return -1
    for (let d = 0; d < this.slots; d++) if (this.ids[d] === id && this.state[d] !== EMPTY) return d
    return -1
  }

  /** Select the living dragonfly nearest (x, y) within `maxDist` px (or none); returns whether one was found. */
  select(x, y, maxDist = 14) {
    let best = -1
    let bestD2 = maxDist * maxDist
    for (let d = 0; d < this.slots; d++) {
      if (this.state[d] === EMPTY) continue
      const d2 = (this.pos[d * 2] - x) ** 2 + (this.pos[d * 2 + 1] - y) ** 2
      if (d2 < bestD2) {
        bestD2 = d2
        best = d
      }
    }
    this.selectedId = best >= 0 ? this.ids[best] : 0
    this.writePoints()
    return best >= 0
  }

  selectedInfo() {
    const d = this.slotOf(this.selectedId)
    if (d < 0) return null
    const gi = d * NG
    return {
      id: this.ids[d],
      generation: this.generation[d],
      age: this.age[d],
      life: this.life[d],
      energy: this.energy[d],
      doing: this.state[d] === PERCHED ? (this.energy[d] < this.genes[gi + G.huntBelow] ? 'waiting in ambush' : 'perched') : this.prey[d] >= 0 ? 'chasing' : this.evicting[d] >= 0 ? 'chasing off a rival' : this.eating[d] > 0 ? 'eating' : this.goal[d] === TO_LAY ? 'going to lay' : this.goal[d] === TO_PERCH ? 'going to perch' : 'patrolling',
      kills: this.kills[d],
      children: this.children[d],
      colour: [this.genes[gi + G.red], this.genes[gi + G.green], this.genes[gi + G.blue]],
      genes: dragonGenomeToObject(this.genes.subarray(gi, gi + NG)),
    }
  }

  /** Mean and spread of each gene over the living dragonflies ({ count, generation, genes, spread }), or null. */
  population() {
    const slots = []
    let gen = 0
    let maxGen = 0
    for (let d = 0; d < this.slots; d++) {
      if (this.state[d] === EMPTY) continue
      slots.push(d)
      gen += this.generation[d]
      maxGen = Math.max(maxGen, this.generation[d])
    }
    if (!slots.length) return null
    return { count: slots.length, generation: gen / slots.length, maxGeneration: maxGen, ...summarize(DRAGON_GENES, this.genes, slots) }
  }

  stats() {
    return {
      alive: this.alive,
      clutches: this.clutches,
      deaths: { ...this.deaths },
      eaten: this.insects.deaths.eaten,
      extinctions: this.extinctions,
      extinct: this.extinct,
      time: this.time,
      history: this.history.slice(),
      population: this.population(),
      selected: this.selectedInfo(),
    }
  }
}
