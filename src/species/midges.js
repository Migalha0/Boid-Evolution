import { SHELTER_CELL, SOURCE } from '../gpu/PondGpu.js'
import { genomeToObject, geneLimit, randomGenome } from '../sim/genetics.js'
import { Wind } from '../sim/Wind.js'

/** Signed item weights: + approaches, − avoids. */
const SIGNED = '+ approaches it, − keeps away from it'

/**
 * The midge genome: every midge carries its own value of each gene, random
 * for a fresh flock (or a profile's, mutated unless locked) within min..max.
 * A mutation can flip a gene's sign (genetics.js), so every gene also works
 * negative: a negative vision or speed limit counts as 0, a negative flock
 * weight steers the other way, a negative hungerAt / layAt / eatTime never
 * hungers / always lays / leaves at once.
 */
export const MIDGE_GENES = [
  { key: 'vision', label: 'Vision', min: 15, max: 150, unit: ' px', hint: 'how far off it sees anything: other midges, flowers, scum, lily pads' },
  { key: 'minSpeed', label: 'Min speed', min: 0, max: 40, unit: ' px/s', hint: 'never flies slower (0: it can hover)' },
  { key: 'cruise', label: 'Cruise speed', min: 10, max: 80, unit: ' px/s', hint: 'the speed it keeps up on its own (faster burns more energy)' },
  { key: 'maxSpeed', label: 'Max speed', min: 30, max: 120, unit: ' px/s', hint: 'never flies faster' },
  { key: 'cohesion', label: 'Cohesion', min: 0, max: 3, unit: '', hint: 'how hard it steers towards the middle of the midges it sees (− away from it)' },
  { key: 'separation', label: 'Separation', min: 0, max: 3, unit: '', hint: 'how hard it steers away from the midges it sees, by 1 / distance² (personal space; − towards them)' },
  { key: 'alignment', label: 'Alignment', min: 0, max: 3, unit: '', hint: 'how hard it matches the heading of the midges it sees (− turns against it)' },
  { key: 'flowers', label: 'Flower pull', min: -3, max: 3, unit: '', hint: `flowers of its colour: ${SIGNED}; only as hungry as it is` },
  { key: 'flowerR', label: 'Flower colour: red', min: 0, max: 1, unit: '', hint: 'the colour it looks for in flowers (red, green, blue; a negative channel counts as 0)' },
  { key: 'flowerG', label: 'Flower colour: green', min: 0, max: 1, unit: '', hint: 'the colour it looks for in flowers (red, green, blue; a negative channel counts as 0)' },
  { key: 'flowerB', label: 'Flower colour: blue', min: 0, max: 1, unit: '', hint: 'the colour it looks for in flowers (red, green, blue; a negative channel counts as 0)' },
  { key: 'colourTolerance', label: 'Colour tolerance', min: 0.05, max: 1, unit: '', hint: 'how far (in rgb) a flower\'s colour may be from its own and still draw it, less the further off (negative: none do)' },
  { key: 'scum', label: 'Scum', min: -3, max: 3, unit: '', hint: SIGNED },
  { key: 'pads', label: 'Lily pads', min: -3, max: 3, unit: '', hint: SIGNED },
  { key: 'hungerAt', label: 'Hungry below', min: 0.1, max: 0.9, unit: '', hint: 'energy below which it is hungry: flowers draw it, and touching one it lands to drink' },
  { key: 'eatTime', label: 'Stays to eat', min: 1, max: 60, unit: ' s', hint: 'how long it stays on a flower once landed (less if the flower runs dry or something pulls it off)' },
  { key: 'layAt', label: 'Lays above', min: 0.4, max: 1, unit: '', hint: 'energy above which scum draws it (as strongly as it is above), and touching scum it lays an egg' },
]

/** What a midge recognises: its own kind (the flock), and item sources (gpu/PondGpu.js). */
export const MIDGE_SENSES = [
  { key: 'midges', label: 'Midges', kind: 'flock' },
  { key: 'flowers', label: 'Flowers (by colour)', kind: 'items', sources: [SOURCE.purple, SOURCE.yellow], weight: 'flowerMatch(id)' },
  { key: 'scum', label: 'Scum', kind: 'items', source: SOURCE.scum },
  { key: 'pads', label: 'Lily pads', kind: 'items', source: SOURCE.pads },
]

/** Point states (render/shaders.js insectVS draws by them), kept in aux.y. */
export const MODE = { flying: 0, onFlower: 2, falling: 3, dead: 4, egg: 5, empty: 6 }
/** Why one died (aux1.w once dead). */
export const DEATH = { starved: 1, old: 2 }
/** Most midges one counts, and candidates looked at per one counted (bounds the cost in a swarm). */
const MAX_NEIGHBOURS = 8
const SCAN_PER_NEIGHBOUR = 6
/** Drinking: energy per s on a flower. */
const FEED_RATE = 0.25
/** Laying: energy an egg costs the midge, and the hatchling starts with. */
export const EGG_COST = 0.3

/**
 * Midges as a species of the GPU base boid. Everything a midge does is its
 * genes weighing what it senses:
 *
 * - Its own kind within its vision: cohesion, alignment and separation (by
 *   1 / distance², from no closer than 1 px). Scum and lily pads: each a
 *   pull or push by a signed gene. Flowers by their colour as drawn (fresh
 *   when full, fading to withered as they are drunk: Vegetation
 *   headColours): its flower gene's pull or push, weighed by how close the
 *   colour is to its colour genes (within its tolerance gene), and only as
 *   hungry as it is (an S-curve of its energy around its hungerAt gene).
 * - It senses all that every `midgeLookEvery` steps (its tick rate; in
 *   turn, a share of the flock each step) and in between steers by what it
 *   last sensed.
 * - Its own propulsion keeps it near its cruise speed, between its min and
 *   max; random buzz, the map's edge and the wind (less in the lee of plants
 *   and trunks) push it too.
 * - Energy burns flying (`insectHunger` per s at 70 px/s, growing with speed
 *   squared), less perched. Touching an open flower while hungry it stops on
 *   it and drinks (a dry one it can only tell by touching) (FEED_RATE per s; gpu/PondGpu.js takes the sips off the
 *   flower), braking towards one it likes within ARRIVE px. It takes off
 *   after its eatTime gene's seconds, when the flower is dry, or when its
 *   flock and the items it senses (not the flowers, separation or the edge)
 *   pull harder than TAKEOFF.
 * - Above its layAt gene's energy scum draws it (an S-curve of how far
 *   above, like hunger), and touching scum in flight it lays an egg there
 *   (EGG_COST of its energy). The egg is placed in a free slot by the main
 *   thread (engine/Laying.js, a mutated copy of its genome) and hatches
 *   after `eggHatchTime` s. Until that egg is placed it lays no other
 *   (u_eggAck: the sim time the main thread has read laying up to).
 * - Past `midgeLifespan` s since hatching it ages: every second past it
 *   its speeds are multiplied by `midgeAgeSlow` and its energy burn by
 *   `midgeAgeBurn` (compounding), until it starves (counted as old age).
 * - At zero energy it starves: falls (off its flower too), lies as a body
 *   for `insectBodyTime` s (varied per midge, by its seed), and is gone.
 *
 * aux: (energy, mode MODE, flower slot when perched / body timer / egg
 * ripeness 0..1, height); aux1: (when it last laid, where: x, y, since when
 * perched / why it died DEATH); traits: (seed, hatched at (s), -, -).
 */
export const MIDGES = {
  name: 'midges',
  genes: MIDGE_GENES,
  senses: MIDGE_SENSES,
  forces: [
    ['cohesion', 'fCo'],
    ['alignment', 'fAl'],
    ['separation', 'fSe'],
    ['flowers', 'fFlowers'],
    ['scum', 'fScum'],
    ['pads', 'fPads'],
    ['laying', 'fLay'],
    ['propulsion', 'fProp'],
    ['edge', 'fEdge'],
    ['drift', 'fDrift'],
    ['total', 'fTotal'],
  ],
  modeChannel: 1, // aux.y: only flying midges are in the flock grid
  auxTextures: 2,
  /** Tick rate: steps between looks (params.midgeLookEvery); in between it recalls these flock totals and its items. */
  tickParam: 'midgeLookEvery',
  remember: { n: 'int', sc: 'vec2', sv: 'vec2', sp: 'vec2' },
  /** Feeding (gpu/PondGpu.js drink): perched on a flower, its slot in aux.z. */
  eats: { modeChannel: 1, idChannel: 2, mode: MODE.onFlower, rate: FEED_RATE },
  maxRange: () => geneLimit(MIDGE_GENES[0]),
  /** Fastest a midge moves (px/s): its top speed gene's limit plus the strongest wind. */
  maxSpeed: (p) => geneLimit(MIDGE_GENES[3]) + Wind.maxSpeed(p) * p.insectWind,
  textures: ['u_items', 'u_itemCells', 'u_nectar', 'u_flowerLook', 'u_shelter'],
  bindTextures: ({ pond }) => ({ u_items: pond.items.items, u_itemCells: pond.items.cells, u_nectar: pond.nectarTexture, u_flowerLook: pond.flowerLook, u_shelter: pond.shelter }),
  setUniforms(gl, u, { params: p, pond, laying, wind }) {
    pond.items.setUniforms(gl, u)
    const a = (wind.direction * Math.PI) / 180
    const windSpeed = wind.speed * p.insectWind
    gl.uniform2f(u.u_wind, Math.sin(a) * windSpeed, -Math.cos(a) * windSpeed)
    gl.uniform1f(u.u_lowness, 1 / (1 + windSpeed / 25)) // in a strong wind swarms keep low
    gl.uniform1f(u.u_burn, p.insectHunger)
    gl.uniform1f(u.u_lifespan, p.midgeLifespan)
    gl.uniform1f(u.u_ageSlow, p.midgeAgeSlow)
    gl.uniform1f(u.u_ageBurn, p.midgeAgeBurn)
    gl.uniform1f(u.u_bodyTime, p.insectBodyTime)
    gl.uniform2i(u.u_shelterDims, pond.shelterDims[0], pond.shelterDims[1])
    gl.uniform1f(u.u_hatchTime, p.eggHatchTime)
    gl.uniform1f(u.u_eggAck, laying?.ack ?? 0)
    gl.uniform1i(u.u_maxNeighbors, MAX_NEIGHBOURS)
    gl.uniform1i(u.u_scanBudget, MAX_NEIGHBOURS * SCAN_PER_NEIGHBOUR)
  },
  /** Alive: flying or perched (aux at offset o). */
  alive: (a, o = 0) => a[o + 1] === MODE.flying || a[o + 1] === MODE.onFlower,
  /** The selected midge for the panel, from its state, aux, traits and genome (at sim time `time`). */
  describe(s, a, tr, genome, time, p) {
    const genes = genomeToObject(MIDGE_GENES, genome)
    const energy = a[0]
    return {
      doing: a[1] === MODE.onFlower ? 'eating' : a[1] === MODE.flying ? 'flying' : 'dead',
      energy,
      age: Math.max(0, time - tr[1]),
      lifespan: p?.midgeLifespan ?? 0,
      hunger: 1 / (1 + Math.exp(12 * (energy - genes.hungerAt))),
      speed: Math.hypot(s[2], s[3]),
      genes,
    }
  },
  /** A fresh midge at (x, y), hatched at sim time `time`: state, aux, aux1, traits, genome (given, or random). */
  spawn(x, y, p, genome, time = 0) {
    const g = genome ?? randomGenome(MIDGE_GENES)
    const a = Math.random() * Math.PI * 2
    const cruise = g[2]
    return {
      state: [x, y, Math.cos(a) * cruise, Math.sin(a) * cruise],
      aux: [0.5 + Math.random() * 0.5, MODE.flying, -1, 6],
      aux1: [-1, 0, 0, 0],
      traits: [Math.random(), time, 0, 0],
      genome: g,
    }
  },
  /** An egg at (x, y) with the hatchling's genome, hatching at sim time `hatch`. */
  egg(x, y, genome, hatch) {
    return {
      state: [x, y, 0, 0],
      aux: [EGG_COST, MODE.egg, 0, 0],
      aux1: [-1, 0, 0, 0],
      traits: [Math.random(), hatch, 0, 0],
      genome,
    }
  },
  /** Laying (engine/Laying.js): aux1 holds when it last laid (x) and where (y, z); eggs are boids in MODE.egg. */
  lays: { modeChannel: 1, egg: MODE.egg, empty: MODE.empty, alive: [MODE.flying, MODE.onFlower], causeChannel: 3, lockParam: 'midgeLocked' },
  glsl: {
    decl: /* glsl */ `
uniform sampler2D u_nectar;  // per plant slot: (nectar, state 0 open, -, -) (gpu/PondGpu.js)
uniform sampler2D u_flowerLook; // 2 texels per plant slot: its flower's colours, fresh and withered (gpu/PondGpu.js)
uniform sampler2D u_shelter; // wind shelter, ${SHELTER_CELL} px cells
uniform ivec2 u_shelterDims;
uniform vec2 u_wind;
uniform float u_lowness;
uniform float u_burn;
uniform float u_lifespan; // s from hatching before it ages
uniform float u_ageSlow;  // past it, speeds x this per s
uniform float u_ageBurn;  // past it, energy burn x this per s
uniform float u_bodyTime;
uniform float u_hatchTime; // s an egg takes to hatch
uniform float u_eggAck;    // it may lay again once its last egg was read (laid before this sim time)
const float COHESION = 3.0;
const float ALIGNMENT = 2.0;
const float SEPARATION = 5000.0;
const float ITEM_PULL = 150.0;
const float PROPEL = 4.0;
const float JITTER = 100.0;
const float EDGE = 80.0;
const float EDGE_PUSH = 300.0;
const float ARRIVE = 25.0;
const float CONTACT = 3.0;
const float FEED_RATE = ${FEED_RATE.toFixed(3)};
const float TAKEOFF = 300.0;
const float EGG_COST = ${EGG_COST.toFixed(3)};
const float LAY_CONTACT = 5.0;
const float HUNGER_STEEP = 12.0;
const float COST_SPEED = 70.0;
const float REST_DRAIN = 0.3;
#define FLOCK_ON (RANGE > 0.0)
#define FLOCK_N n
#define DEBUG_POS pos
#define DEBUG_VEL vel
bool flowerOpen(float id) {
  int w = textureSize(u_nectar, 0).x;
  vec4 f = texelFetch(u_nectar, ivec2(int(id) % w, int(id) / w), 0);
  return f.g == 0.0 && f.r >= 0.02;
}
// A flower's colour as drawn: from withered to fresh by the nectar in it
// (render/shaders.js plantVS). How full it looks is all a midge can tell
// from afar; only touching it does it find out whether it is open.
vec3 flowerColour(float id) {
  int w = textureSize(u_nectar, 0).x;
  int i = int(id);
  float nectar = texelFetch(u_nectar, ivec2(i % w, i / w), 0).r;
  int lw = textureSize(u_flowerLook, 0).x;
  vec3 fresh = texelFetch(u_flowerLook, ivec2(i * 2 % lw, i * 2 / lw), 0).rgb;
  vec3 withered = texelFetch(u_flowerLook, ivec2((i * 2 + 1) % lw, (i * 2 + 1) / lw), 0).rgb;
  return mix(withered, fresh, smoothstep(0.0, 1.0, nectar));
}
// How much it is drawn to a colour: 1 at the colour it wants, 0 at its
// tolerance away (rgb distance) and beyond (a negative tolerance: nothing).
float colourMatch(vec3 c, vec3 want, float tolerance) {
  return tolerance > 0.0 ? max(0.0, 1.0 - distance(c, want) / tolerance) : 0.0;
}
// A flower, by its colour genes (read once in main: flowerWant, flowerTolerance).
#define flowerMatch(id) colourMatch(flowerColour(id), flowerWant, flowerTolerance)
// Random numbers: an integer hash (PCG) of the midge and the step, three
// independent ones each uniform in 0..1 (zero-mean once centred, so the
// buzz pushes no way in particular).
uint pcg(uint v) {
  uint st = v * 747796405u + 2891336453u;
  uint word = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
  return (word >> 22u) ^ word;
}
float unit(uint h) { return (float(h >> 8u) + 0.5) / 16777216.0; }
float shelterAt(vec2 p) {
  ivec2 t = clamp(ivec2(p / ${SHELTER_CELL.toFixed(1)}), ivec2(0), u_shelterDims - 1);
  return texelFetch(u_shelter, t, 0).r;
}
`,
    pre: /* glsl */ `
  float mode = aux.y;
  bool alive = mode == ${MODE.flying.toFixed(1)} || mode == ${MODE.onFlower.toFixed(1)};
  float RANGE = alive ? max(G_VISION, 0.0) : 0.0; // a negative vision sees nothing
  vec4 traits = texelFetch(u_traits, own, 0);
  float seed = traits.x;
  vec3 flowerWant = clamp(vec3(G_FLOWER_R, G_FLOWER_G, G_FLOWER_B), 0.0, 1.0); // a negative channel counts as 0
  float flowerTolerance = G_COLOUR_TOLERANCE;
  int n = 0;
  vec2 sc = vec2(0.0);
  vec2 sv = vec2(0.0);
  vec2 sp = vec2(0.0);`,
    visit: /* glsl */ `
        n++;
        sc += d;
        sv += nb.zw;
        float e2 = max(d2, 1.0);
        sp -= d / (e2 * sqrt(e2)); // away by 1 / distance²`,
    act: /* glsl */ `
  float energy = aux.x;
  float tag = aux.z;
  float z = aux.w;
  uint hs = pcg(floatBitsToUint(seed) ^ pcg(floatBitsToUint(u_time)));
  float rnd = unit(hs);
  float r2 = unit(pcg(hs + 1u)) - 0.5;
  float r3 = unit(pcg(hs + 2u)) - 0.5;
  float bodyTime = u_bodyTime * (0.7 + 0.6 * fract(seed * 91.7)); // its own (render/shaders.js midgeVS reads it back for the ripple)
  float hunger = 1.0 / (1.0 + exp(HUNGER_STEEP * (energy - G_HUNGER_AT)));
  float broody = 1.0 / (1.0 + exp(-HUNGER_STEEP * (energy - G_LAY_AT))); // as hunger, above its layAt gene
  vec2 fCo = n > 0 ? sc / float(n) * COHESION * G_COHESION : vec2(0.0);
  vec2 fAl = n > 0 ? (sv / float(n) - vel) * ALIGNMENT * G_ALIGNMENT : vec2(0.0);
  vec2 fSe = sp * SEPARATION * G_SEPARATION;
  vec2 fFlowers = P_flowers * G_FLOWERS * ITEM_PULL * hunger;
  vec2 fScum = P_scum * G_SCUM * ITEM_PULL;
  vec2 fPads = P_pads * G_PADS * ITEM_PULL;
  vec2 fLay = P_scum * ITEM_PULL * broody;
  vec2 fEdge = vec2(
    pos.x < EDGE ? EDGE_PUSH * (1.0 - pos.x / EDGE) : pos.x > u_world.x - EDGE ? -EDGE_PUSH * (1.0 - (u_world.x - pos.x) / EDGE) : 0.0,
    pos.y < EDGE ? EDGE_PUSH * (1.0 - pos.y / EDGE) : pos.y > u_world.y - EDGE ? -EDGE_PUSH * (1.0 - (u_world.y - pos.y) / EDGE) : 0.0);
  vec2 fProp = vec2(0.0);
  vec2 fDrift = vec2(0.0);
  vec2 fTotal = vec2(0.0);

  if (mode == ${MODE.egg.toFixed(1)}) {
    // An egg on the scum: ripening until its hatching time (traits.y), then a midge.
    tag = clamp(1.0 - (traits.y - u_time) / max(u_hatchTime, 1e-3), 0.0, 1.0);
    vel = vec2(0.0);
    if (u_time >= traits.y) {
      mode = ${MODE.flying.toFixed(1)};
      tag = -1.0;
      z = 1.0;
      float a = rnd * 6.2832;
      vel = vec2(cos(a), sin(a)) * G_CRUISE;
    }
  } else if (mode == ${MODE.falling.toFixed(1)}) {
    // Starved: dropping to the water or ground (off its flower, if it died on one).
    z -= 25.0 * u_dt;
    pos += u_wind * 0.3 * u_dt;
    if (z <= 0.0) { z = 0.0; mode = ${MODE.dead.toFixed(1)}; tag = bodyTime; }
  } else if (mode == ${MODE.dead.toFixed(1)}) {
    tag -= u_dt;
    if (tag <= 0.0) mode = ${MODE.empty.toFixed(1)};
  } else if (alive) {
    bool perched = mode == ${MODE.onFlower.toFixed(1)};
    float speed = length(vel);
    // Past its lifespan, every second slower and hungrier (compounding).
    float over = max(0.0, u_time - traits.y - u_lifespan);
    float ageSpeed = pow(u_ageSlow, over);
    float ageBurn = pow(u_ageBurn, over);
    energy -= u_burn * ageBurn * (perched ? REST_DRAIN : 0.3 + 0.7 * (speed / COST_SPEED) * (speed / COST_SPEED)) * u_dt;
    bool open = perched && flowerOpen(tag);
    if (open) energy = min(1.0, energy + FEED_RATE * u_dt);
    if (energy <= 0.0) {
      // Starved (of old age, past its lifespan): down it goes.
      energy = 0.0;
      aux1.w = over > 0.0 ? ${DEATH.old.toFixed(1)} : ${DEATH.starved.toFixed(1)};
      mode = ${MODE.falling.toFixed(1)};
      if (perched) { z = 2.0; tag = -1.0; }
    } else if (perched) {
      // On a flower: for its eatTime gene (aux1.w: since when), until the flower
      // is dry, or pulled off (flock and items; not flowers, separation or the edge).
      vec2 pull = fCo + fAl + fScum + fPads + fLay;
      fTotal = pull + fSe + fEdge;
      vel = vec2(0.0);
      if (u_time - aux1.w >= G_EAT_TIME || !open || length(pull) > TAKEOFF) { mode = ${MODE.flying.toFixed(1)}; tag = -1.0; z = 1.0; }
    } else {
      // Negative speed genes: no slower than 0, no faster than its min (0: it cannot fly).
      float minS = max(G_MIN_SPEED, 0.0) * ageSpeed;
      float maxS = max(minS, G_MAX_SPEED * ageSpeed);
      float cruise = clamp(G_CRUISE * ageSpeed, minS, maxS);
      // Near a flower whose colour it likes, a hungry midge brakes to stop on it.
      vec4 near = NEAR_flowers;
      float like = near.z >= 0.0 ? G_FLOWERS * flowerMatch(near.z) : 0.0;
      if (hunger > 0.05 && near.w < ARRIVE && like > 0.0) {
        vec2 dv = near.xy - pos;
        float dd = max(length(dv), 1e-3);
        fFlowers += (dv / dd * min(cruise, dd * 3.0) - vel) * like * hunger * 3.0;
      }
      // Its own propulsion towards its cruise speed, along where it heads.
      vec2 h = speed > 1.0 ? vel / speed : vec2(cos(rnd * 6.2832), sin(rnd * 6.2832));
      fProp = h * (cruise - speed) * PROPEL;
      fTotal = fCo + fAl + fSe + fFlowers + fScum + fPads + fLay + fEdge + fProp;
      vec2 buzz = vec2(r2, r3) * (JITTER * 2.0) / sqrt(max(u_dt, 1e-3));
      vel += (fTotal + buzz) * u_dt;
      float sp1 = length(vel);
      float held = clamp(sp1, minS, maxS);
      vel = sp1 > 1e-6 ? vel * (held / sp1) : h * held;
      // The wind carries it, less in the lee of plants and trunks.
      fDrift = u_wind * (1.0 - shelterAt(pos - u_wind * 0.5));
      pos = clamp(pos + (vel + fDrift) * u_dt, vec2(0.0), u_world);
      float tz = (6.0 + 5.0 * sin(u_time * 2.0 + seed * 40.0)) * u_lowness;
      z += (tz - z) * min(1.0, u_dt * 2.0);
      // Touching an open flower while hungry (below its hungerAt gene): it lands and drinks.
      if (energy < G_HUNGER_AT && near.z >= 0.0 && distance(pos, near.xy) <= CONTACT && flowerOpen(near.z)) {
        mode = ${MODE.onFlower.toFixed(1)};
        tag = near.z;
        pos = near.xy;
        vel = vec2(0.0);
        z = 0.0;
        aux1.w = u_time;
      } else if (energy > G_LAY_AT && energy > EGG_COST && aux1.x < u_eggAck && NEAR_scum.z >= 0.0 && distance(pos, NEAR_scum.xy) <= LAY_CONTACT) {
        // Touching scum with energy to spare (above its layAt gene): it lays
        // an egg there, once its last one was read (engine/Laying.js).
        energy -= EGG_COST;
        aux1.xyz = vec3(u_time, pos);
      }
    }
  }
  o_state = vec4(pos, vel);
  o_aux = vec4(energy, mode, tag, z);
  o_aux1 = aux1;`,
  },
}
