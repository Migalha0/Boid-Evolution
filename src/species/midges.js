import { SHELTER_CELL, SOURCE } from '../gpu/PondGpu.js'
import { geneMacro } from '../gpu/boids/codegen.js'
import { genomeToObject, geneLimit, randomGenome } from '../sim/genetics.js'
import { CLOUD_FIELD } from '../render/shaders.js'
import { cloudTune, RAIN_GLSL } from '../sim/Rain.js'
import { Wind, windPattern } from '../sim/Wind.js'

/**
 * The wiring: what a midge senses (inputs) acts straight on what it does
 * (outputs). A link (input to output) is a gene, a bit, made and broken by
 * mutation (genetics.js), random for a fresh flock; each element of its
 * input has a weight gene of its own on it, acting only while the link is
 * there.
 *
 * Inputs come in two ranks (`rank`):
 *   vector (rank 1)  everything of its kind it sees within its vision (in
 *                    3D), summed: each element is a 3D vector, the sum over
 *                    the things seen of (its way, a unit vector, or for a
 *                    heading its velocity less its own) x its closeness (1
 *                    at it, 0 at the edge of its vision), so it points to
 *                    the near-weighted middle of them and grows with how
 *                    many and how near; and a strength, the sum of the
 *                    closenesses (how many, how near), a scalar. Midges,
 *                    lily pads, scum, coloured things, self (its velocity),
 *                    threat (not in yet).
 *                    Noise: direction (wander) is a vector too: a random
 *                    sideways unit vector turning smoothly (its wander rate
 *                    gene), strength 1.
 *   scalar (rank 0)  one number: noise, brightness, age, energy, constant 1,
 *                    and the latches (memory: 0 or 1, LATCHES).
 * Outputs:
 *   steering (vector)  the sum over its links of weight x vector (x
 *             VECTOR_PULL; a heading x HEADING_PULL), and from a scalar
 *             weight x it, up or down only (x SCALAR_PULL): a force in px/s²
 *   eat, lay (scalar)  the sum over its links of weight x strength (a
 *             scalar: x it); above 0 the output is on (the larger wins)
 * Coloured things: only flower heads near its colour gene (seekRed, seekGreen,
 * seekBlue; genes that mutate, iris yellow in a fresh flock), each counted by how near: 1 at
 * that colour, 0 at COLOUR_TOLERANCE away (RGB distance) and beyond.
 * Self: its velocity (pushing along it keeps it going against the drag;
 * strength its speed / 70 px/s). Noise: a random number each step, uniform
 * in −1..1 (averaging 0).
 *
 * Between an input and an output, each link passes what its elements add up
 * to through its activation (ACTIVATIONS, a gene per link): on eat and lay
 * the sum itself, on steering the push's size (in LINK_UNIT px/s²), keeping
 * its way. Then its gate (GATES, a gene per link, and a gate input gene:
 * which input) may scale or switch it by another input's value: a link that
 * acts only while hungry, or only near scum.
 *
 * `vec`, `amt`: an element's direction (already a force) and strength, GLSL
 * in act; `seen`: how many it sees (GLSL), for the diagram.
 */
/** Activation functions a link can have (f of x, the sum on the link). */
export const ACTIVATIONS = [
  { key: 'linear', label: 'linear', short: 'lin', hint: 'x: passes it as it is' },
  { key: 'step', label: 'step', short: 'step', hint: '1 above 0, else 0: on or off' },
  { key: 'tanh', label: 'tanh', short: 'tanh', hint: 'tanh x: like linear near 0, levelling off at ±1' },
  { key: 'relu', label: 'ReLU', short: 'relu', hint: 'x above 0, else 0: only the positive part' },
  { key: 'gauss', label: 'Gaussian', short: 'gaus', hint: 'e^(−x²): 1 at 0, fading to 0 either way (strongest when the sum is near 0)' },
  { key: 'sine', label: 'sine', short: 'sin', hint: 'sin x: rises and falls again, repeating' },
  { key: 'sigmoid', label: 'sigmoid', short: 'sig', hint: '1 / (1 + e^(−x)): a soft step from 0 to 1, ½ at 0' },
  { key: 'abs', label: 'abs', short: 'abs', hint: '|x|: how big, whichever sign' },
]
/**
 * Neuron types an output with memory (eat, lay) can have: what it makes of
 * the sum of its links (x) before the on/off test, keeping one number (m)
 * from step to step. a = 1 − e^(−rate·dt), the share of the way m moves to x
 * in a step (rate: its rate gene, per s).
 */
export const NODE_TYPES = [
  { key: 'plain', label: 'plain', short: '', hint: 'y = x: passes the sum on as it is (no memory)' },
  { key: 'latch', label: 'latch', short: 'latch', hint: 'switches on (1) when the sum reaches 1, off (0) when it falls to 0 or below, and in between stays as it was (its rate unused)' },
  { key: 'smooth', label: 'smooth', short: 'smooth', hint: 'y = m, m moving towards the sum at its rate: a moving average, reacting late and ignoring flicker' },
  { key: 'change', label: 'change', short: 'change', hint: 'y = x − m, m moving towards the sum at its rate: answers a change, fading back to 0 while the sum holds (it gets used to it)' },
]
/**
 * Logic gates a link can have (per link: a gate gene, an index into GATES; a
 * gate input gene, which input opens or closes it; a threshold gene, t). The
 * link's result (after its activation) is multiplied by g(m), m the gate
 * input's value clamped to 0..1: a scalar input's number, a vector input's
 * strength (how many, how near). So one input can switch, scale or reverse
 * another: (coloured things) UNLESS (latch) pulls it to flowers only while
 * its latch is off. `formula`: g(m), as the panels show it; `symbol`: before
 * the gate input's name on the diagram; `threshold`: it uses t.
 */
export const GATES = [
  { key: 'none', label: 'none', symbol: '', formula: 'g = 1', hint: 'no gate: the link passes as it is' },
  { key: 'and', label: 'AND', symbol: '∧', formula: 'g = m', hint: 'scaled by the gate input: full when it is 1, nothing when it is 0 (only when m)' },
  { key: 'andnot', label: 'AND NOT', symbol: '∧¬', formula: 'g = 1 − m', hint: 'scaled by the gate input’s opposite: full when it is 0, nothing when it is 1 (only when not m)' },
  { key: 'if', label: 'IF', symbol: 'if ', formula: 'g = 1 if m > t, else 0', threshold: true, hint: 'on or off: passes only while the gate input is above its threshold t (a gene)' },
  { key: 'unless', label: 'UNLESS', symbol: 'if ¬', formula: 'g = 0 if m > t, else 1', threshold: true, hint: 'on or off: passes only while the gate input is at or below its threshold t (a gene)' },
  { key: 'flip', label: 'FLIP', symbol: '±', formula: 'g = −1 if m > t, else 1', threshold: true, hint: 'reverses the link while the gate input is above its threshold t (a gene): a pull becomes a push (repulsion), a drive a brake' },
]
/** A gate's factor g for gate input m (clamped to 0..1) and threshold t: the same maths as the shader's gate(). */
export function gateFactor(k, m, t = 0.5) {
  const c = Math.min(1, Math.max(0, m))
  if (k === 1) return c
  if (k === 2) return 1 - c
  if (k === 3) return c > t ? 1 : 0
  if (k === 4) return c > t ? 0 : 1
  if (k === 5) return c > t ? -1 : 1
  return 1
}
/**
 * Latches: memory inputs. Each is 0 or 1, kept from step to step, and set by
 * its own genes: a source (any input, its value clamped to 0..1 as a gate
 * input's), an on threshold and an off threshold. With on ≥ off it switches
 * on when the source reaches on and off when it falls to off (a rising
 * latch: energy, on 0.8, off 0.2 is "full"); with on < off, on when the
 * source falls to on and off when it rises to off (a falling latch:
 * "hungry"). In between it holds. 0 at hatching. Kept as bits of aux.w's
 * fraction (the generation is its whole part), so at most MAX_LATCHES.
 */
export const LATCHES = [{ key: 'latch', label: 'latch' }]
const MAX_LATCHES = 4
if (LATCHES.length > MAX_LATCHES) throw new Error(`At most ${MAX_LATCHES} latches`)
export const latchKeys = (l) => ({ src: `${l.key}Src`, on: `${l.key}On`, off: `${l.key}Off` })
const latchVar = (l) => `latch_${l.key}`
/**
 * Every constant the wiring computes with, the same for every midge. The
 * GLSL constants are generated from this list and the brain panels show it,
 * so none acts unseen: anything new that shapes the brain goes here (or, if
 * a setting, in BRAIN_PARAMS; if per midge, a gene).
 */
export const BRAIN_CONSTANTS = [
  { key: 'VECTOR_PULL', value: 150, unit: 'px/s² per unit', on: 'vector inputs → steering', hint: 'how hard a vector input (midges where, lily pads, scum, coloured things) pushes per unit of what it sees, at weight 1' },
  { key: 'HEADING_PULL', value: 1, unit: '/s', on: 'midges (heading) → steering', hint: 'px/s² per px/s of the others’ velocity less its own, at weight 1' },
  { key: 'SCALAR_PULL', value: 100, unit: 'px/s² per unit', on: 'scalar inputs → steering', hint: 'a scalar input (noise, brightness, age, energy, constant 1) has no direction, so it steers only up or down: this per unit, at weight 1' },
  { key: 'SELF_PULL', value: 1, unit: '/s', on: 'self → steering', hint: 'px/s² per px/s of its own velocity, at weight 1' },
  { key: 'COST_SPEED', value: 70, unit: 'px/s', on: 'self (strength)', hint: 'self’s strength (to eat and lay) is its speed divided by this (it is also the speed flight cost is quoted at)' },
  { key: 'COLOUR_TOLERANCE', value: 0.35, unit: 'RGB distance', on: 'coloured things', hint: 'a flower head counts by how near its colour (as drawn: withering as drunk) is to its colour gene: fully at it, not at all this far off (RGB 0..1 each) or more' },
  { key: 'GROUND_VISION', value: 0.1, unit: '× its vision at 0 px', on: 'every input, by height', hint: 'at the water or ground (0 px up) it sees only this share as far as its vision gene, rising linearly to all of it at FULL_VISION_Z' },
  { key: 'FULL_VISION_Z', value: 10, unit: 'px', on: 'every input, by height', hint: 'at this height and above it sees as far as its vision gene' },
  { key: 'HEIGHT_PULL', value: 2, unit: 'px/s² per px', on: 'flight height gene (height hold)', hint: 'flying (eat and lay off), it is pulled towards its flight height gene: this much up per px below it (down per px above), on top of its steering' },
  { key: 'HEIGHT_DAMP', value: 1.5, unit: '/s', on: 'flight height gene (height hold)', hint: 'the height hold also brakes its climb or sink by this per px/s, so it settles at its height with a little bob instead of bouncing' },
  { key: 'GLIDE_STEER', value: 0.5, unit: '× steering', on: 'coming down (eat or lay on)', hint: 'coming down, its steering’s sideways push still acts at this share, so it glides in (curving towards what it steers to) rather than dropping straight' },
  { key: 'SINK_RATE', value: 3, unit: '/s', on: 'coming down (eat or lay on)', hint: 'coming down, its sink speed eases towards 20 px/s at this rate (from however it was climbing or sinking), rather than switching at once' },
  { key: 'LINK_UNIT', value: 100, unit: 'px/s²', on: 'every link to steering', hint: 'a steering link’s activation gets the push’s size divided by this, and its result is multiplied back by it (keeping the push’s direction)' },
]
/** How far a midge sees by height (the renderer draws its ring so): this share of its vision at 0 px, all of it from FULL_VISION_Z up. */
export const GROUND_VISION = BRAIN_CONSTANTS.find((c) => c.key === 'GROUND_VISION').value
export const FULL_VISION_Z = BRAIN_CONSTANTS.find((c) => c.key === 'FULL_VISION_Z').value
/** The fixed rules the wiring follows (shown in the brain panels). */
export const BRAIN_RULES = [
  'Each link sums its weighted input elements, then passes the sum through its activation.',
  'A gated link’s result (after its activation) is multiplied by its gate’s g(m): m is its gate input’s value (a vector input’s strength), clamped to 0..1. AND: m; AND NOT: 1 − m; IF: 1 above its threshold gene t, else 0; UNLESS: the reverse; FLIP: −1 above t, else 1. A gate costs no energy (its link does).',
  'A latch (memory input) is 0 or 1 and holds between its two threshold genes: its source (a gene: any input, clamped to 0..1) reaching its on threshold switches it on, reaching its off threshold switches it off (rising if on ≥ off, falling if on < off). It is 0 at hatching and costs no energy.',
  'Noise: direction is a sideways unit vector of its own, easing to a new random heading every 1 / (its wander rate gene) seconds.',
  'Steering: the links’ pushes add up to a force; a link’s activation acts on its push’s size (in LINK_UNIT), keeping its direction.',
  'Eat and lay: the links’ results add up, pass through that output’s neuron (type and rate genes), and the output is on above 0; if both are on, the larger wins (eat on a tie).',
  'With eat or lay on, steering is ignored: it brakes, sinks straight down, and stays down while it is on.',
  'Things on the water or ground (lily pads, scum, coloured things) pull it only sideways: its height is its own (the flight height gene, held by HEIGHT_PULL and HEIGHT_DAMP), plus what its steering pushes up or down.',
  'Coming down (eat or lay on), it glides: its steering acts sideways at GLIDE_STEER, it brakes, and its sink eases to 20 px/s (SINK_RATE).',
  'At 0 px it cannot fly without lift: with eat and lay off it takes off only while its steering plus its height hold push up (a flight height above 0 always does); otherwise it rests there, stopped.',
  'It sees less the lower it is: GROUND_VISION of its vision at 0 px, rising linearly to all of it at FULL_VISION_Z and above.',
  'Vector inputs (rank 1) give steering their vector and eat and lay their strength (a scalar); scalar inputs (rank 0) give eat and lay their value, and steering only up or down.',
  'It senses every N steps (its tick rate) and acts every step on what it last sensed; noise, self, age, energy the wander direction and the neurons and latches are fresh every step. Midges take turns sensing (a share each step), except at sim speeds of N× and up, where all sense on the same step (as often each).',
  'Its neurons’ memory starts at 0 when it hatches.',
  'Wiring costs energy every second, whether a link acts or not.',
]
/** The settings (params) that act on the brain or how it evolves (shown in the brain panels). */
export const BRAIN_PARAMS = [
  { key: 'midgeLookEvery', label: 'Senses every', fmt: (v) => `${v} step${v === 1 ? '' : 's'}`, hint: 'its tick rate: it acts on its last senses in between' },
  { key: 'linkCost', label: 'First link costs', fmt: (v) => `${v} e/s`, hint: 'energy per second of its first link' },
  { key: 'linkGrowth', label: 'Each further link costs more by', fmt: (v) => `${(v * 100).toFixed(1)}%`, hint: 'compounding, link by link' },
  { key: 'mutationCount', label: 'Background mutations', fmt: (v) => `${v} per hatchling`, hint: 'mean of the Poisson count of mutations, plus its own mutations gene' },
  { key: 'mutationSize', label: 'Background mutation size', fmt: (v) => `σ ${v}`, hint: 'plus its own mutation size gene' },
  { key: 'mutationRelative', label: 'Multiplicative share', fmt: (v) => `${Math.round(v * 100)}%`, hint: 'how much of a mutation scales the gene (×(1+σ·share)^Z) rather than adding to it (σ·(1−share)·range·Z)' },
  { key: 'mutationFlip', label: 'Sign flip chance', fmt: (v) => `${Math.round(v * 100)}% of mutations`, hint: 'a mutation flips the gene’s sign instead' },
  { key: 'wireRate', label: 'Rewire chance', fmt: (v) => `${v} per link`, hint: 'each link it could have, made or broken in a hatchling' },
  { key: 'gateStart', label: 'Starting gates', fmt: (v) => `${Math.round((v ?? 0) * 100)}% of links`, hint: 'a fresh random flock: chance each link has a gate (a random one, on a random input); after that gates evolve by mutation like activations (a mutation of a gate gene switches it to another gate, none included)' },
  { key: 'midgeLocked', label: 'Profile locked', fmt: (v) => (v ? 'yes: no mutations' : 'no'), hint: 'locked, every hatchling is an exact copy' },
]
export const MIDGE_INPUTS = [
  {
    key: 'midges',
    label: 'midges',
    seen: 'float(n)',
    elements: [
      { key: 'where', vec: 'sPos.xyz * VECTOR_PULL', amt: 'sPos.w' },
      { key: 'heading', vec: 'sHead.xyz * HEADING_PULL', amt: 'sPos.w' },
    ],
  },
  { key: 'pads', label: 'lily pads', seen: 'float(N_pads)', elements: [{ key: 'where', vec: 'iPads.xyz * VECTOR_PULL', amt: 'iPads.w' }] },
  { key: 'scum', label: 'scum', seen: 'float(N_scum)', elements: [{ key: 'where', vec: 'iScum.xyz * VECTOR_PULL', amt: 'iScum.w' }] },
  {
    key: 'colour',
    label: 'coloured things',
    seen: 'iCol.w',
    hint: 'flower heads near its colour gene (it mutates; iris yellow in a fresh flock), each by how near its colour is (a drunk one withers and fades out)',
    elements: [{ key: 'where', vec: 'iCol.xyz * VECTOR_PULL', amt: 'iCol.w' }],
  },
  {
    key: 'threat',
    label: 'threat',
    none: true,
    seen: '0.0',
    elements: [
      { key: 'where', vec: 'vec3(0.0)', amt: '0.0' },
      { key: 'heading', vec: 'vec3(0.0)', amt: '0.0' },
    ],
  },
  { key: 'self', label: 'self: velocity', seen: 'length(vec3(vel, vz))', elements: [{ key: 'velocity', vec: 'vec3(vel, vz) * SELF_PULL', amt: 'length(vec3(vel, vz)) / COST_SPEED' }] },
  { key: 'noise', label: 'noise', number: 'noiseAmt', hint: 'a random number each step, uniform in −1..1 (averaging 0)' },
  { key: 'brightness', label: 'brightness', number: 'alive ? sHead.w : 0.0', hint: 'how much sun reaches it, right where it is: 1 clear, 0 under a cloud core (1 with clouds off)' },
  { key: 'age', label: 'age', number: 'ageNow / max(u_lifespan, 1.0)' },
  { key: 'energy', label: 'energy', number: 'energy / u_energyMax' },
  { key: 'bias', label: 'constant 1', number: '1.0', hint: 'always 1: a link from it is a bias, moving that output’s threshold (to steering: a steady push up or down)' },
  // Last, so the links of profiles saved before it keep their bits.
  {
    key: 'wander',
    label: 'noise: direction',
    seen: '1.0',
    hint: 'a random sideways direction (a unit vector, strength 1) that turns smoothly, a new random heading about every 1 / (its wander rate gene) s, its own for each midge: to steering it makes it roam, to eat and lay it is a constant 1',
    elements: [{ key: 'where', vec: 'vec3(wanderDir, 0.0) * VECTOR_PULL', amt: '1.0' }],
  },
  ...LATCHES.map((l) => ({ key: l.key, label: l.label, latch: l, number: latchVar(l), hint: '0 or 1, remembered: switched on and off by its source input crossing its two threshold genes (see the rules); a gate input or a link like any other' })),
].map((input) => (input.number ? { ...input, rank: 0, seen: input.number, elements: [{ key: 'value', vec: `vec3(0.0, 0.0, (${input.number}) * SCALAR_PULL)`, amt: `(${input.number})` }] } : { ...input, rank: 1, vector: true }))
/**
 * What each input and output is, for the brain guide (components/BrainPanel.jsx):
 * `about` what it senses or does, `range` its values, `updates` how and when
 * it changes over time, and for an input `steer` / `drive` what a link from
 * it gives steering and eat or lay. Kept here, next to the definitions, so
 * the guide says what the code does.
 */
export const INPUT_DOCS = {
  midges: {
    about: 'Other midges in flight within its vision, in 3D. Two elements: where (towards the near-weighted middle of them) and heading (their velocity less its own: how they are flying compared to it).',
    range: 'Grows with how many it sees and how near: each one counts by its closeness, 1 right on it, 0 at the edge of its vision. Strength: the sum of the closenesses.',
    updates: 'Sensed every tick (Senses every N steps); in between it acts on its last look.',
    steer: 'where: a pull towards them (cohesion; negative weight: keep away). heading: match their flight (alignment).',
  },
  pads: { about: 'Lily pads within its vision. On the water, so they pull it sideways only: its height is its own.', range: 'A vector to the near-weighted middle of the pads seen; strength the sum of their closenesses.', updates: 'Sensed every tick.' },
  scum: { about: 'Duckweed scum within its vision: the only place its eggs hatch. On the water: sideways only.', range: 'A vector to the near-weighted middle of the scum seen; strength the sum of closenesses (a mat counts many times).', updates: 'Sensed every tick.' },
  colour: {
    about: 'Flower heads near its colour gene (three genes, red, green and blue, that mutate; a fresh flock starts at iris yellow), each counted by how near its colour is, as drawn: a flower fades as it is drunk, so a dry one withers out of view. It cannot tell from afar whether a flower is open.',
    range: 'Each head: closeness × colour match (1 a fresh iris right on it). Summed over every head in view, so a patch adds up to more than 1.',
    updates: 'Sensed every tick; colours change as flowers are drunk and refill.',
  },
  threat: { about: 'Dragonflies. Not in the sim yet.', range: 'Always 0.', updates: 'Never.' },
  self: {
    about: 'Its own velocity, in 3D.',
    range: 'The vector is its velocity (px/s); its strength is its speed ÷ 70 px/s.',
    updates: 'Every step.',
    steer: 'Pushes along where it is already going: keeps it flying against the air drag (negative weight: brakes).',
  },
  noise: {
    about: 'A random number, drawn fresh every simulation step, independent of the last: white noise, no memory.',
    range: 'Uniform in −1..1, averaging 0.',
    updates: 'A new draw every step (not every tick), so it flickers; at a higher sim speed there are more draws per second of sim time, not different ones.',
    steer: 'A scalar has no direction: it only jiggles the midge up and down about its height. To roam sideways use noise: direction.',
    drive: 'Adds a random nudge each step: an output near its threshold flickers on and off.',
  },
  brightness: { about: 'How much sun reaches it, right where it is.', range: '1 in clear sun, 0 under a cloud core (1 with clouds off).', updates: 'Sensed every tick; changes as clouds drift with the wind.' },
  age: { about: 'How old it is, against the lifespan (World settings).', range: '0 at hatching, 1 at its lifespan, still rising past it (when it slows and burns more).', updates: 'Every step, rising steadily.' },
  energy: { about: 'How full it is.', range: '1 full (the energy reserve), 0 starving.', updates: 'Every step: falls with its burn (body, flight, wiring), rises while it drinks, drops by a clutch’s cost when it lays.' },
  bias: { about: 'A constant.', range: 'Always 1.', updates: 'Never changes.', steer: 'A steady push up (or down, negative weight).', drive: 'Moves the output’s threshold: negative makes it harder to switch on, positive easier.' },
  wander: {
    about: 'A sideways heading of its own, to roam by.',
    range: 'A unit vector (length 1) in the water plane; strength always 1.',
    updates: 'Continuously. Every 1 ÷ (its wander rate gene) seconds it draws a new random heading and turns to it the shorter way round, easing in and out (smoothstep), so it sweeps smoothly instead of jumping. Each midge has its own random sequence, so no two turn together; every direction is equally likely.',
    steer: 'A push its way: a midge with nothing else in view roams.',
    drive: 'A constant 1 (like the bias).',
  },
  latch: {
    about: 'Memory: a switch that stays where it was set. It watches its source input (a gene) and switches on when the source reaches its on threshold, off when it reaches its off threshold (both genes).',
    range: '0 or 1. 0 when it hatches.',
    updates: 'Every step. With on ≥ off it is a rising latch (energy on at 0.9, off at 0.5: “full” until laying has spent it); with on < off it falls (“hungry”). Between the two thresholds it holds.',
    steer: 'As a scalar, up or down only: mostly useful as a gate input (IF latch, UNLESS latch, FLIP latch).',
  },
}
export const OUTPUT_DOCS = {
  steer: {
    about: 'Where it flies: the sum of its steering links, a force in px/s² (3D).',
    how: 'Flying, it adds to the hold on its flight height and the air drag, capped by its max speed gene. With eat or lay on, only half its sideways part acts (it glides in). At the water it takes off only if steering plus the height hold push up.',
  },
  eat: {
    about: 'Whether it comes down to eat.',
    how: 'The sum of its eat links passes through its eat neuron (type and rate genes); above 0 eat is on (if it is larger than lay). On: it glides down and stays down. On an open flower (within 4 px) it drinks at the feeding rate; anywhere else it eats nothing.',
  },
  lay: {
    about: 'Whether it comes down to lay.',
    how: 'The sum of its lay links through its lay neuron; above 0 lay is on (if larger than eat). On: it comes down and lays a clutch whenever it has more energy than the clutch costs. Only eggs laid on scum (within 5 px) hatch; the rest are wasted.',
  },
}
/** An input's or output's rank, as the panels label it. */
export const RANK = ['scalar', 'vector']
export const MIDGE_OUTPUTS = [
  { key: 'steer', label: 'steering (x, y, z)', rank: 1 },
  { key: 'eat', label: 'eat', neuron: true, rank: 0 },
  { key: 'lay', label: 'lay', neuron: true, rank: 0 },
]
/** An output neuron's type and rate genes' keys. */
export const nodeKey = (out) => `node_${out}`
export const rateKey = (out) => `rate_${out}`
const NI = MIDGE_INPUTS.length
const NO = MIDGE_OUTPUTS.length
export const WIRE_BITS = NI * NO
const WIRE_WORD = 24
const WIRE_WORDS = Math.ceil(WIRE_BITS / WIRE_WORD)
/** The bit of the link from input i to output o, and the weight gene's key of its element el on it. */
export const linkBit = (i, o) => i * NO + o
export const weightKey = (i, el, o) => `w_${MIDGE_INPUTS[i].key}_${el}_${MIDGE_OUTPUTS[o].key}`
/** A test of each bit from a genes object ({ wires0, wires1, ... }). */
export function wiresOf(genes) {
  const words = Array.from({ length: WIRE_WORDS }, (_, k) => genes[`wires${k}`] ?? 0)
  return (b) => ((words[(b / WIRE_WORD) | 0] >> b % WIRE_WORD) & 1) === 1
}
/** The wiring genes ({ wires0, wires1, ... }) holding exactly the given link bits. */
export function wiresFrom(bits) {
  const genes = Object.fromEntries(Array.from({ length: WIRE_WORDS }, (_, k) => [`wires${k}`, 0]))
  for (const b of bits) genes[`wires${(b / WIRE_WORD) | 0}`] |= 1 << b % WIRE_WORD
  return genes
}
/** The wiring genes: random links (each there with chance params.wireStart). */
const WIRE_GENES = Array.from({ length: WIRE_WORDS }, (_, k) => {
  const bits = Math.min(WIRE_WORD, WIRE_BITS - k * WIRE_WORD)
  return {
    key: `wires${k}`,
    label: `Wiring ${k + 1}`,
    min: 0,
    max: 2 ** bits - 1,
    bits,
    wires: true,
    random: (p) => {
      let w = 0
      for (let b = 0; b < bits; b++) if (Math.random() < (p?.wireStart ?? 0.3)) w |= 1 << b
      return w
    },
  }
})
/**
 * Each link's own genes, four in a row (one GPU texel, read only while the
 * link is there): its activation (an index into ACTIVATIONS), its gate (an
 * index into GATES: there with chance params.gateStart in a fresh flock, a
 * random one; a profile without it: none), its gate input (an index into
 * MIDGE_INPUTS) and its gate threshold (t, 0..1). The choices mutate by
 * switching to another one, so a link gains, changes and loses its gate as
 * it evolves; the threshold mutates like any number.
 */
export const activationKey = (i, o) => `a_${MIDGE_INPUTS[i].key}_${MIDGE_OUTPUTS[o].key}`
export const gateKey = (i, o) => `g_${MIDGE_INPUTS[i].key}_${MIDGE_OUTPUTS[o].key}`
export const gateInputKey = (i, o) => `gi_${MIDGE_INPUTS[i].key}_${MIDGE_OUTPUTS[o].key}`
export const gateThresholdKey = (i, o) => `gt_${MIDGE_INPUTS[i].key}_${MIDGE_OUTPUTS[o].key}`
const LINK_GENES = MIDGE_INPUTS.flatMap((input, i) =>
  MIDGE_OUTPUTS.flatMap((out, o) => [
    { key: activationKey(i, o), label: `${input.label} → ${out.key}: activation`, min: 0, max: ACTIVATIONS.length - 1, choices: ACTIVATIONS.length, activation: true },
    {
      key: gateKey(i, o),
      label: `${input.label} → ${out.key}: gate`,
      min: 0,
      max: GATES.length - 1,
      choices: GATES.length,
      default: 0,
      gate: true,
      random: (p) => (Math.random() < (p?.gateStart ?? 0.3) ? 1 + Math.floor(Math.random() * (GATES.length - 1)) : 0),
    },
    { key: gateInputKey(i, o), label: `${input.label} → ${out.key}: gate input`, min: 0, max: MIDGE_INPUTS.length - 1, choices: MIDGE_INPUTS.length, default: 0, gate: true },
    { key: gateThresholdKey(i, o), label: `${input.label} → ${out.key}: gate threshold`, min: 0, max: 1, default: 0.5, unit: '', gate: true, hint: 'IF, UNLESS and FLIP switch where the gate input crosses this' },
  ]),
)
/** Each latch's genes (LATCHES): its source input, its on and its off threshold. */
const LATCH_GENES = LATCHES.flatMap((l) => {
  const k = latchKeys(l)
  return [
    { key: k.src, label: `${l.label}: source`, min: 0, max: MIDGE_INPUTS.length - 1, choices: MIDGE_INPUTS.length, default: Math.max(0, MIDGE_INPUTS.findIndex((x) => x.key === 'energy')), latch: true, brainGene: true, hint: 'the input it watches (its value clamped to 0..1, a vector input’s strength)' },
    { key: k.on, label: `${l.label}: on at`, min: 0, max: 1, default: 0.8, unit: '', latch: true, brainGene: true, hint: 'it switches on when its source reaches this (from below if on ≥ off, from above if on < off)' },
    { key: k.off, label: `${l.label}: off at`, min: 0, max: 1, default: 0.2, unit: '', latch: true, brainGene: true, hint: 'it switches off when its source reaches this' },
  ]
})
/** Each output with a neuron (eat, lay): its type (NODE_TYPES) and its rate (per s, mutated by scaling only). */
const NODE_GENES = MIDGE_OUTPUTS.filter((o) => o.neuron).flatMap((o) => [
  { key: nodeKey(o.key), label: `${o.key} neuron: type`, min: 0, max: NODE_TYPES.length - 1, choices: NODE_TYPES.length, default: 0, node: true, hint: `what its ${o.key} neuron makes of the sum of its links (a profile without it: plain)` },
  { key: rateKey(o.key), label: `${o.key} neuron: rate`, min: 0.1, max: 10, unit: ' /s', relative: true, node: true, default: 1, random: () => 10 ** (Math.random() * 2 - 1), hint: `how fast its ${o.key} neuron’s memory follows the sum (smooth, change)` },
])
/** Fresh weights start small (within ±START_WEIGHT), though mutation can take them anywhere in ±3. */
const START_WEIGHT = 0.5
/**
 * A weight gene per element of each link (acting only while the link is
 * there), a link's weights side by side; inputs with two elements first, so
 * none straddles two texels (one read per link).
 */
const WEIGHT_GENES = MIDGE_INPUTS.map((input, i) => [input, i])
  .sort(([a], [b]) => b.elements.length - a.elements.length)
  .flatMap(([input, i]) =>
    MIDGE_OUTPUTS.flatMap((out, o) =>
      input.elements.map((el) => {
        const name = input.number ? input.label : `${input.label} (${el.key})`
        return { key: weightKey(i, el.key, o), label: `${name} → ${out.key}`, min: -3, max: 3, unit: '', weight: true, random: () => (Math.random() * 2 - 1) * START_WEIGHT, hint: `how much ${name} adds to its ${out.key} output (− takes away)` }
      }),
    ),
  )

/** Iris yellow (sim/Vegetation.js, the iris head's colour). */
export const IRIS_YELLOW = [0.88, 0.76, 0.22]
/**
 * Its colour gene (what “coloured things” sees), one gene per channel (0..1;
 * mutation can push one past either end, which counts as the end). A random
 * flock starts at iris yellow, so it can see food at all; mutation drifts it
 * from there, towards other flower colours or away from all of them.
 */
const SEEK_GENES = ['Red', 'Green', 'Blue'].map((c, k) => ({ key: `seek${c}`, label: `Seeks colour: ${c.toLowerCase()}`, min: 0, max: 1, default: IRIS_YELLOW[k], random: () => IRIS_YELLOW[k], seek: true, unit: '', hint: 'its colour gene: “coloured things” sees only flower heads near this colour (it mutates; a random flock starts at iris yellow)' }))
export const seekColour = (genes) => SEEK_GENES.map((g) => genes?.[g.key] ?? g.default)

/**
 * The midge genome: every midge carries its own value of each gene, random
 * for a fresh flock (or a profile's, mutated unless locked) within min..max.
 * A mutation can flip a gene's sign (genetics.js), so every gene also works
 * negative: a negative vision or speed counts as 0. Laid out for the GPU
 * (gene k in texel k >> 2): each link's own genes first (a texel each), then
 * what the brain reads every step (its links, its latches, its wander
 * rate), its link weights, then its body (and its own mutation genes) and
 * its output neurons. Profiles keep genes by name, so the order is free.
 */
export const MIDGE_GENES = [
  ...LINK_GENES,
  ...WIRE_GENES,
  ...LATCH_GENES,
  { key: 'wanderRate', label: 'Wander rate', min: 0.1, max: 3, default: 0.5, unit: ' /s', relative: true, brainGene: true, random: () => 10 ** (Math.random() * 1.48 - 1), hint: 'how fast its noise: direction turns: a new random heading about every 1 / this seconds, eased in between' },
  ...WEIGHT_GENES,
  { key: 'vision', label: 'Vision', min: 15, max: 150, unit: ' px', hint: 'how far off it sees anything: other midges, flowers, scum, lily pads' },
  { key: 'maxSpeed', label: 'Max speed', min: 30, max: 120, unit: ' px/s', hint: 'never flies faster (faster burns more energy)' },
  { key: 'flyHeight', label: 'Flight height', min: 2, max: 40, default: 10, unit: ' px', hint: 'the height it holds while flying (HEIGHT_PULL): steering pushes it up or down from there; at 0 or below it holds the water, flying only on its steering’s lift' },
  { key: 'eggEnergy', label: 'Energy per clutch', min: 0.1, max: 1.5, default: 0.3, unit: ' e', hint: 'energy it puts into each clutch, split evenly among the hatchlings; it lays only with more than this (below 0.02 counts as 0.02)' },
  { key: 'clutch', label: 'Clutch size', min: 1, max: 4, default: 1, unit: '', hint: 'hatchlings per clutch: the whole number, and one more by chance by the fraction (2.4: two, three 40% of the time); below 1 counts as 1, at most 8' },
  ...SEEK_GENES,
  { key: 'mutCount', label: 'Own mutations', min: 0, max: 6, default: 2, unit: ' /hatchling', evolvability: true, hint: 'added to the background mutations (Evolution) for its hatchlings: the mean of how many genes mutate (below 0 counts as 0)' },
  { key: 'mutSigma', label: 'Own mutation size', min: 0, max: 0.2, default: 0.05, unit: '', evolvability: true, hint: 'added to the background mutation size for its hatchlings (below 0 counts as 0)' },
  ...NODE_GENES,
]

const gene = (key) => MIDGE_GENES.findIndex((g) => g.key === key)
/** Where the vision gene lies in the genome (the renderer reads it for the vision rings: the order is free, so never assume it). */
export const VISION_GENE = gene('vision')
const CLUTCH_GENE = gene('clutch')
const EGG_ENERGY_GENE = gene('eggEnergy')
const MAX_SPEED_GENE = gene('maxSpeed')

/** What a midge recognises: its own kind (the flock), and item sources (gpu/PondGpu.js), each adding to its inputs as it sees one (visit: d, dd, id). */
export const MIDGE_SENSES = [
  { key: 'midges', label: 'Midges', kind: 'flock' },
  { key: 'flowers', label: 'Coloured things (flower heads)', kind: 'items', sources: [SOURCE.purple, SOURCE.yellow, SOURCE.cattail], visit: 'seeItem(d, id, true);' },
  { key: 'scum', label: 'Scum', kind: 'items', source: SOURCE.scum, visit: 'seeItem(d, id, false);' },
  { key: 'pads', label: 'Lily pads', kind: 'items', source: SOURCE.pads, visit: 'iPads += itemWay(d);' },
]

/** Point states (render/shaders.js insectVS draws by them), kept in aux.y. Down: on the water or the ground, eating (nothing) or laying. */
export const MODE = { flying: 0, down: 1, onFlower: 2, falling: 3, dead: 4, egg: 5, empty: 6 }
/** Why one died (aux1.w once dead). */
export const DEATH = { starved: 1, old: 2, rain: 3 }
/** Most midges one counts, and candidates looked at per one counted (bounds the cost in a swarm). */
const MAX_NEIGHBOURS = 8
const SCAN_PER_NEIGHBOUR = 6
/** Each midge's own number (traits.z), never given twice in a session (eggs get theirs when laid). */
let nextId = 1
/** Laying: the least energy a clutch takes (its eggEnergy gene below this, or negative, counts as this), and the most hatchlings in one. */
const MIN_CLUTCH_ENERGY = 0.02
const MAX_CLUTCH = 8

/**
 * Midges as a species of the GPU base boid. Everything a midge does is its
 * wiring (above) acting on what it senses:
 *
 * - Within its vision (in 3D: flower heads, scum and pads lie at the water
 *   or the ground, height 0): other midges (where and heading), lily pads,
 *   scum, and coloured things (flower heads: iris, pickerelweed, cattail
 *   spikes; their colour as drawn, fresh when full, withering as drunk),
 *   counting only those near its colour gene, by how near. Threat
 *   (dragonflies, not in yet) is always 0. Brightness: how much sun reaches
 *   it, right where it is, 1 clear .. 0 under cloud cores. Its age (1 at its
 *   lifespan), energy (1 full) and noise (random, −1..1).
 * - It senses every `midgeLookEvery` steps (its tick rate; in turn, a share
 *   of the flock each step) and in between acts on what it last sensed.
 * - Flying: steering drives it, and a damped pull (HEIGHT_PULL,
 *   HEIGHT_DAMP) holds it near its flight height gene (things on the water
 *   pull it only sideways); air drag (DRAG) slows it, its max speed gene
 *   caps it (slower past its lifespan), the map's edge and a ceiling (MAX_Z)
 *   stop it, and the wind carries it (harder higher up, less in the lee of
 *   plants and trunks).
 * - Eat or lay on: it glides down (its steering sideways at GLIDE_STEER,
 *   braking, its sink easing to DESCEND) to the water or ground and stays
 *   there while that output is on; off, it takes off if its steering plus
 *   its height hold push up. Down eating, touching an open flower (CONTACT) it drinks
 *   (`midgeFeedRate` e per s; gpu/PondGpu.js takes the sips off the
 *   flower); anywhere else it eats nothing. Down laying, with more energy
 *   than the clutch costs (its eggEnergy gene, which the hatchlings share,
 *   plus `eggCost` per egg, spent), it lays a clutch: how many eggs (its
 *   clutch gene's count) is drawn here and kept in aux1.w; on scum
 *   (LAY_CONTACT) the main thread (engine/Laying.js) places them (each a
 *   mutated copy of its genome with an even share of the eggEnergy, hatching
 *   after `eggHatchTime` s); anywhere else they are wasted. It lays again once that clutch was read (u_eggAck).
 * - Energy burns: a base `midgeBaseBurn` per s, plus flying `insectHunger`
 *   per s at 70 px/s (with speed squared), plus its wiring (neural):
 *   u_linkCost its first link, each further one u_linkGrowth times the one
 *   before (n links: u_linkCost x (g^n - 1) / (g - 1)).
 * - Past `midgeLifespan` s since hatching it ages: every second past it its
 *   energy burn is multiplied by 1 + `midgeAgeing` and its max speed divided
 *   by it (compounding), until it starves (counted as old age).
 * - At zero energy it starves: falls, lies as a body for `insectBodyTime` s
 *   (varied per midge, by its seed), and is gone. A raindrop falling through
 *   it in flight kills it (DEATH.rain); the drops are the very ones drawn.
 *
 * aux: (energy, mode MODE, flower slot when on one / body timer / egg
 * ripeness 0..1, generation: 0 spawned, its parent's + 1 hatched, plus its
 * latches' states as bits of the fraction); vert: (height above the water (px), its rate, its eat and lay neurons' memory); aux1:
 * (when it last laid, where: x, y (x -1: wasted, off scum), why it died
 * DEATH); traits: (seed, hatched at (s), its own number (never given twice), -).
 */
/**
 * The wiring as straight-line GLSL (inside `if (alive)` in act), generated
 * here rather than looped over in the shader: every gene texel it needs is
 * fetched once, each link's bit is a constant test, and an input's elements
 * are worked out only inside the links that use them. (GPUs run a loop over
 * arrays indexed by a variable from slow memory, and a texture fetch per
 * gene adds up: this keeps the brain in registers.) A link's genes are read
 * only while it is there (about two texels each), so a midge pays for the
 * links it has, not for every link it could have. Per link: the sum of
 * weight x element, through its activation, times its gate.
 */
function brainGlsl() {
  const T = Math.max(1, Math.ceil(MIDGE_GENES.length / 4))
  const index = Object.fromEntries(MIDGE_GENES.map((g, k) => [g.key, k]))
  // Genes read together: each texel they lie in fetched once into a local
  // (prefix0, prefix1, ...), and each gene's GLSL by key (ref).
  const block = (keys, prefix, pad) => {
    const texels = [...new Set(keys.map((key) => index[key] >> 2))]
    const ref = (key) => `${prefix}${texels.indexOf(index[key] >> 2)}.${'xyzw'[index[key] & 3]}`
    return { fetches: texels.map((t, j) => `${pad}vec4 ${prefix}${j} = texelFetch(u_genes, ivec2(own.x * ${T} + ${t}, own.y), 0);`), ref }
  }
  const out = []
  // Read every step: its links (wiring words) and its latches' genes.
  const always = block([...WIRE_GENES.map((g) => g.key), ...LATCH_GENES.map((g) => g.key)], 'bs', '    ')
  out.push(...always.fetches)
  for (let k = 0; k < WIRE_WORDS; k++) out.push(`    uint wires${k} = uint(${always.ref(`wires${k}`)});`)
  // Every input's value as a gate (or latch) input: a scalar's number, a vector's strength (clamped where used).
  out.push('    float gIn[NI];')
  MIDGE_INPUTS.forEach((input, i) => out.push(`    gIn[${i}] = ${input.elements[0].amt};`))
  // The latches: each from its last state, by its source and thresholds; then the input it is.
  LATCHES.forEach((l) => {
    const k = latchKeys(l)
    const v = latchVar(l)
    out.push(`    { // latch ${l.key}`)
    out.push(`      float lm = clamp(gIn[clamp(int(${always.ref(k.src)}), 0, NI - 1)], 0.0, 1.0);`)
    out.push(`      float lOn = ${always.ref(k.on)};`)
    out.push(`      float lOff = ${always.ref(k.off)};`)
    out.push(`      ${v} = lOn >= lOff ? (lm >= lOn ? 1.0 : (lm <= lOff ? 0.0 : ${v})) : (lm <= lOn ? 1.0 : (lm >= lOff ? 0.0 : ${v}));`)
    out.push(`      gIn[${MIDGE_INPUTS.findIndex((x) => x.key === l.key)}] = ${v};`)
    out.push('    }')
  })
  // Each link: its genes read only if it is there (its own four in one texel, its weights in the next).
  MIDGE_INPUTS.forEach((input, i) => {
    MIDGE_OUTPUTS.forEach((o, k) => {
      const b = linkBit(i, k)
      const lb = block([activationKey(i, k), gateKey(i, k), gateInputKey(i, k), gateThresholdKey(i, k), ...input.elements.map((el) => weightKey(i, el.key, k))], 'lt', '      ')
      const w = (el) => lb.ref(weightKey(i, el.key, k))
      const act = `int(${lb.ref(activationKey(i, k))})`
      out.push(`    if (((wires${(b / WIRE_WORD) | 0} >> ${b % WIRE_WORD}u) & 1u) == 1u) { // ${input.key} -> ${o.key}`)
      out.push(...lb.fetches)
      out.push('      links++;')
      out.push('      float g = 1.0;')
      out.push(`      int gk = int(${lb.ref(gateKey(i, k))});`)
      out.push(`      if (gk != 0) g = gate(gk, gIn[clamp(int(${lb.ref(gateInputKey(i, k))}), 0, NI - 1)], ${lb.ref(gateThresholdKey(i, k))});`)
      if (o.key === 'steer') {
        out.push(`      vec3 v = ${input.elements.map((el) => `${w(el)} * (${el.vec})`).join(' + ')};`)
        out.push('      float m = length(v);')
        out.push(`      if (m > 1e-6) { sIn[${i}] = v / m * activate(${act}, m / LINK_UNIT) * LINK_UNIT * g; steer += sIn[${i}]; }`)
      } else {
        const arr = o.key === 'eat' ? 'eIn' : 'lIn'
        const sum = o.key === 'eat' ? 'eatOut' : 'layOut'
        out.push(`      ${arr}[${i}] = activate(${act}, ${input.elements.map((el) => `${w(el)} * (${el.amt})`).join(' + ')}) * g;`)
        out.push(`      ${sum} += ${arr}[${i}];`)
      }
      out.push('    }')
    })
  })
  return out.join('\n')
}
const BRAIN_GLSL = brainGlsl()

export const MIDGES = {
  name: 'midges',
  genes: MIDGE_GENES,
  senses: MIDGE_SENSES,
  /** What each direction input adds to its steering (its x, y), then the rest. */
  forces: [
    ...MIDGE_INPUTS.flatMap((input, i) => (input.vector ? [[input.key, `sIn[${i}].xy`]] : [])),
    ['drag', 'fDrag'],
    ['descend', 'fBrake'],
    ['drift', 'fDrift'],
    ['total', 'fTotal'],
  ],
  /** What it weighed, for the selected one's wiring diagram (components/MidgePanel.jsx): each input's strength, what each link adds, the outputs. */
  signals: [
    ...MIDGE_INPUTS.map((input) => [`in_${input.key}`, input.seen]),
    ...MIDGE_INPUTS.map((input, i) => [`steer_${input.key}`, `length(sIn[${i}])`]),
    ...MIDGE_INPUTS.map((input, i) => [`eat_${input.key}`, `eIn[${i}]`]),
    ...MIDGE_INPUTS.map((input, i) => [`lay_${input.key}`, `lIn[${i}]`]),
    ['steer', 'length(steer)'],
    ['steerZ', 'steer.z'],
    ['hold', 'fHold'],
    ['holdAt', 'max(G_FLY_HEIGHT, 0.0)'],
    ['eat', 'eatOut'],
    ['lay', 'layOut'],
    ['eatSum', 'eatSum'],
    ['laySum', 'laySum'],
    ['eatMem', 'memEat'],
    ['layMem', 'memLay'],
    ['links', 'float(links)'],
    ['baseRate', 'baseRate'],
    ['flightRate', 'flightRate'],
    ['neuralRate', 'neuralRate'],
    ['maxS', 'maxS'],
    ['capped', 'capped'],
    ['blocked', 'blocked'],
  ],
  modeChannel: 1, // aux.y: only flying midges are in the flock grid
  vertical: true, // vert: (height above the water (px), its rate, eat neuron memory, lay neuron memory)
  auxTextures: 2,
  /** Tick rate: steps between looks (params.midgeLookEvery); in between it recalls these sums. */
  tickParam: 'midgeLookEvery',
  remember: { n: 'int', sPos: 'vec4', sHead: 'vec4', iPads: 'vec4', iScum: 'vec4', iCol: 'vec4' },
  /** Feeding (gpu/PondGpu.js drink): on a flower, its slot in aux.z. */
  eats: { modeChannel: 1, idChannel: 2, mode: MODE.onFlower, rate: (p) => p.midgeFeedRate },
  maxRange: () => geneLimit(MIDGE_GENES[gene('vision')]),
  /** Fastest a midge moves (px/s): its top speed gene's limit plus the strongest wind. */
  maxSpeed: (p) => geneLimit(MIDGE_GENES[MAX_SPEED_GENE]) + Wind.maxSpeed(p) * p.insectWind,
  textures: ['u_items', 'u_itemCells', 'u_fineItems', 'u_fineCells', 'u_nectar', 'u_flowerLook', 'u_shelter', 'u_clouds'],
  bindTextures: ({ pond, clouds }) => ({ u_items: pond.items.items, u_itemCells: pond.items.cells, u_fineItems: pond.items.fineItems, u_fineCells: pond.items.fineCells, u_nectar: pond.nectarTexture, u_flowerLook: pond.flowerLook, u_shelter: pond.shelter, u_clouds: clouds }),
  setUniforms(gl, u, { params: p, pond, laying, wind, rain, rainCell }) {
    pond.items.setUniforms(gl, u)
    const a = (wind.direction * Math.PI) / 180
    const windSpeed = wind.speed * p.insectWind
    gl.uniform2f(u.u_wind, Math.sin(a) * windSpeed, -Math.cos(a) * windSpeed)
    // Rain, and the clouds it falls from, as the water draws them (render/shaders.js).
    const level = rain.level > 0.01 ? rain.level : 0
    gl.uniform1f(u.u_rain, level)
    gl.uniform2fv(u.u_rainCell, rainCell)
    gl.uniform1i(u.u_cloudsOn, p.showClouds ? 1 : 0)
    gl.uniform3fv(u.u_cloudTune, cloudTune(p, level).slice(0, 3))
    gl.uniform2fv(u.u_cloudShift, wind.shift)
    const pattern = windPattern(wind.direction)
    gl.uniform4fv(u.u_windPair, pattern.pair)
    gl.uniform1f(u.u_windMix, pattern.mix)
    gl.uniform1f(u.u_baseBurn, p.midgeBaseBurn)
    gl.uniform1f(u.u_energyMax, p.midgeEnergyMax)
    gl.uniform1f(u.u_feedRate, p.midgeFeedRate)
    gl.uniform1f(u.u_burn, p.insectHunger)
    gl.uniform1f(u.u_linkCost, p.linkCost)
    gl.uniform1f(u.u_linkGrowth, 1 + p.linkGrowth)
    gl.uniform1f(u.u_lifespan, p.midgeLifespan)
    gl.uniform1f(u.u_ageSlow, 1 / (1 + p.midgeAgeing))
    gl.uniform1f(u.u_ageBurn, 1 + p.midgeAgeing)
    gl.uniform1f(u.u_bodyTime, p.insectBodyTime)
    gl.uniform2i(u.u_shelterDims, pond.shelterDims[0], pond.shelterDims[1])
    gl.uniform1f(u.u_hatchTime, p.eggHatchTime)
    gl.uniform1f(u.u_eggAck, laying?.ack ?? 0)
    gl.uniform1f(u.u_eggCost, Math.max(0, p.eggCost ?? 0))
    gl.uniform1i(u.u_maxNeighbors, MAX_NEIGHBOURS)
    gl.uniform1i(u.u_scanBudget, MAX_NEIGHBOURS * SCAN_PER_NEIGHBOUR)
  },
  /** Alive: flying, down or on a flower (aux at offset o). */
  alive: (a, o = 0) => a[o + 1] === MODE.flying || a[o + 1] === MODE.down || a[o + 1] === MODE.onFlower,
  /** The selected midge for the panel, from its state, aux, traits, genome (at sim time `time`) and vert. */
  describe(s, a, tr, genome, time, p, v) {
    const genes = genomeToObject(MIDGE_GENES, genome)
    const max = p?.midgeEnergyMax ?? 3
    return {
      id: tr[2],
      doing: a[1] === MODE.onFlower ? 'eating' : a[1] === MODE.flying ? 'flying' : a[1] === MODE.down ? 'down' : 'dead',
      energy: Math.min(1, a[0] / max), // how full, 0..1
      energyMax: max,
      generation: Math.floor(a[3]), // its whole part (the fraction holds its latches)
      age: Math.max(0, time - tr[1]),
      lifespan: p?.midgeLifespan ?? 0,
      speed: Math.hypot(s[2], s[3], v?.[1] ?? 0),
      position: [s[0], s[1], v?.[0] ?? 0],
      velocity: [s[2], s[3], v?.[1] ?? 0],
      genes,
    }
  },
  /** A fresh midge at (x, y), hatched at sim time `time`: state, aux, aux1, traits, genome (given, or random). */
  spawn(x, y, p, genome, time = 0) {
    const g = genome ?? randomGenome(MIDGE_GENES, p)
    const a = Math.random() * Math.PI * 2
    const speed = Math.max(0, g[MAX_SPEED_GENE]) * 0.5
    return {
      state: [x, y, Math.cos(a) * speed, Math.sin(a) * speed],
      aux: [(0.5 + Math.random() * 0.5) * (p?.midgeEnergyMax ?? 3), MODE.flying, -1, 0], // generation 0
      aux1: [-1, 0, 0, 0],
      vert: [6, 0, 0, 0],
      traits: [Math.random(), time, nextId++, 0],
      genome: g,
    }
  },
  /** A clutch laid by a midge with this genome: how many eggs (its clutch gene, the fraction by chance) and the energy each hatchling starts with (its eggEnergy gene, shared evenly). */
  clutch(genome, eggs) {
    const size = genome[CLUTCH_GENE]
    // The shader decides how many (it charged the per-egg cost for them); else drawn here alike.
    const count = eggs >= 1 ? Math.min(MAX_CLUTCH, Math.round(eggs)) : Math.min(MAX_CLUTCH, Math.max(1, Math.floor(size) + (Math.random() < size - Math.floor(size) ? 1 : 0)))
    return { count, energy: Math.max(MIN_CLUTCH_ENERGY, genome[EGG_ENERGY_GENE]) / count }
  },
  /** An egg at (x, y) with the hatchling's genome, starting energy and generation, hatching at sim time `hatch`. */
  egg(x, y, genome, hatch, energy, generation = 0) {
    return {
      state: [x, y, 0, 0],
      aux: [energy, MODE.egg, 0, generation],
      aux1: [-1, 0, 0, 0],
      vert: [0, 0, 0, 0],
      traits: [Math.random(), hatch, nextId++, 0],
      genome,
    }
  },
  /** Laying (engine/Laying.js): aux.w its generation; aux1 holds when it last laid (x) and where (y, z; y -1: wasted, off scum); eggs are boids in MODE.egg. */
  lays: { modeChannel: 1, egg: MODE.egg, empty: MODE.empty, alive: [MODE.flying, MODE.down, MODE.onFlower], causeChannel: 3, lockParam: 'midgeLocked' },
  glsl: {
    decl: /* glsl */ `
uniform sampler2D u_nectar;  // per plant slot: (nectar, state 0 open, -, quota: below -1 no flower) (gpu/PondGpu.js)
uniform sampler2D u_flowerLook; // 2 texels per plant slot: its head's colours, fresh and withered (gpu/PondGpu.js)
uniform sampler2D u_fineItems;  // the items again, on a fine grid (gpu/boids/ItemSources.js), for what is right under it
uniform usampler2D u_fineCells; // [start, end) per fine cell
uniform ivec2 u_fineGrid;
uniform float u_fineCell;
uniform sampler2D u_shelter; // wind shelter, ${SHELTER_CELL} px cells
uniform ivec2 u_shelterDims;
uniform vec2 u_wind;
uniform float u_rain;      // 0 dry .. 1 downpour (sim/Rain.js level)
uniform vec2 u_rainCell;   // world px per scene px: the drops' grid (render/shaders.js u_cell)
uniform bool u_cloudsOn;
uniform vec3 u_cloudTune;  // the clouds' scale, cover and edge (sim/Rain.js cloudTune)
uniform float u_baseBurn; // energy per s its body burns, whatever it does
uniform float u_burn;     // what flight adds at 70 px/s (with speed squared)
uniform float u_linkCost;  // energy per s its first link of wiring costs, whatever it is doing
uniform float u_linkGrowth; // each further link costs this times the one before
uniform float u_lifespan; // s from hatching before it ages
uniform float u_ageSlow;  // past it, max speed x this per s
uniform float u_ageBurn;  // past it, energy burn x this per s
uniform float u_energyMax; // energy a full midge holds
uniform float u_feedRate;  // energy per s it drinks on a flower (and the flower loses)
uniform float u_bodyTime;
uniform float u_hatchTime; // s an egg takes to hatch
uniform float u_eggCost;   // energy each egg costs its layer, on top of the clutch's energy
uniform float u_eggAck;    // it may lay again once its last clutch was read (laid before this sim time)
${BRAIN_CONSTANTS.map((c) => `const float ${c.key} = ${c.value.toFixed(6)}; // ${c.unit}: ${c.on}`).join('\n')}
const float DRAG = 0.5;          // 1/s: air drag
const float DESCEND = 20.0;      // px/s it sinks coming down to eat or lay
const float DOWN_BRAKE = 4.0;    // 1/s: how hard it brakes coming down
const float MAX_Z = 40.0;        // px: the highest it can fly
const float CONTACT = 4.0;       // px: on a flower
const float LAY_CONTACT = 5.0;   // px: on scum
const float MIN_CLUTCH_ENERGY = ${MIN_CLUTCH_ENERGY.toFixed(3)};
const int MAX_CLUTCH = ${MAX_CLUTCH};
const float FALL_SPEED = 25.0; // px/s a dead midge drops
const float DROP_FALL = 300.0; // px/s a raindrop falls
const float RAIN_HIT = 1.5;    // scene px: a drop this close to it hits it
// The wiring (MIDGE_INPUTS -> MIDGE_OUTPUTS): links are bits of the wiring
// genes (${WIRE_WORD} bits each; input i to output o is bit i * NO + o), worked
// out in act as straight-line code (BRAIN_GLSL).
const int NI = ${NI};
const int NO = ${NO};
#define CLOUD_SCALE u_cloudTune.x
#define CLOUD_COVER u_cloudTune.y
#define CLOUD_EDGE u_cloudTune.z
${CLOUD_FIELD}
${RAIN_GLSL}
// Whether a drop falls through it (flying at height z) during this step: the
// drops landing about z / DROP_FALL s from now, close enough, from a cloud.
bool hitByRain(vec2 p, float z) {
  vec2 q = p / u_rainCell;
  float t = u_time + max(z, 0.0) / DROP_FALL;
  for (int layer = 0; layer < 2; layer++) {
    ivec2 base = rainCellOf(q, layer);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 at;
        float age, R;
        if (!rainDrop(base + ivec2(i, j), layer, t, u_rain, u_dt, at, age, R) || distance(q, at) > RAIN_HIT) continue;
        if (!u_cloudsOn || cloudCover(at * u_rainCell) > RAIN_CLOUD) return true;
      }
    }
  }
  return false;
}
#define FLOCK_ON (RANGE > 0.0)
#define FLOCK_N n
#define DEBUG_POS pos
#define DEBUG_VEL vel
bool flowerOpen(float id) {
  int w = textureSize(u_nectar, 0).x;
  vec4 f = texelFetch(u_nectar, ivec2(int(id) % w, int(id) / w), 0);
  return f.a > -1.5 && f.g == 0.0 && f.r >= 0.02;
}
// A head's colour as drawn: from withered to fresh by the nectar in it
// (render/shaders.js plantVS; a cattail spike always looks fresh). How full
// it looks is all a midge can tell from afar; only touching it does it find
// out whether it is open.
vec3 flowerColour(float id) {
  int w = textureSize(u_nectar, 0).x;
  int i = int(id);
  float nectar = texelFetch(u_nectar, ivec2(i % w, i / w), 0).r;
  int lw = textureSize(u_flowerLook, 0).x;
  vec3 fresh = texelFetch(u_flowerLook, ivec2(i * 2 % lw, i * 2 / lw), 0).rgb;
  vec3 withered = texelFetch(u_flowerLook, ivec2((i * 2 + 1) % lw, (i * 2 + 1) / lw), 0).rgb;
  return mix(withered, fresh, smoothstep(0.0, 1.0, nectar));
}
// The nearest open flower (flowers) or scum spot within r of p: its id, or -1.
float itemUnder(vec2 p, float r, bool flowers) {
  // On the fine grid (gpu/boids/ItemSources.js FINE_CELL): a few items per cell.
  ivec2 lo = clamp(ivec2(floor((p - r) / u_fineCell)), ivec2(0), u_fineGrid - 1);
  ivec2 hi = clamp(ivec2(floor((p + r) / u_fineCell)), ivec2(0), u_fineGrid - 1);
  float best = r;
  float found = -1.0;
  int left = 128;
  for (int gy = lo.y; gy <= hi.y; gy++) {
    for (int gx = lo.x; gx <= hi.x; gx++) {
      int cid = gy * u_fineGrid.x + gx;
      ivec2 cr = ivec2(texelFetch(u_fineCells, ivec2(cid % u_itemCellsW, cid / u_itemCellsW), 0).xy);
      for (int idx = cr.x; idx < cr.y && left > 0; idx++) {
        left--;
        vec4 it = texelFetch(u_fineItems, ivec2(idx % u_itemsW, idx / u_itemsW), 0);
        int src = int(it.w);
        bool head = src == ${SOURCE.purple} || src == ${SOURCE.yellow} || src == ${SOURCE.cattail};
        if (flowers ? !head : src != ${SOURCE.scum}) continue;
        float dd = distance(it.xy, p);
        if (dd <= best && (!flowers || flowerOpen(it.z))) { best = dd; found = it.z; }
      }
    }
  }
  return found;
}
// A link's activation (ACTIVATIONS, by index).
float activate(int k, float x) {
  if (k == 1) return x > 0.0 ? 1.0 : 0.0;
  if (k == 2) return tanh(x);
  if (k == 3) return max(x, 0.0);
  if (k == 4) return exp(-x * x);
  if (k == 5) return sin(x);
  if (k == 6) return 1.0 / (1.0 + exp(-x));
  if (k == 7) return abs(x);
  return x;
}
// A link's gate (GATES, by index): its factor for gate input m (clamped to 0..1), threshold t.
float gate(int k, float m, float t) {
  m = clamp(m, 0.0, 1.0);
  if (k == 1) return m;
  if (k == 2) return 1.0 - m;
  if (k == 3) return m > t ? 1.0 : 0.0;
  if (k == 4) return m > t ? 0.0 : 1.0;
  if (k == 5) return m > t ? -1.0 : 1.0;
  return 1.0;
}
// An output's neuron (NODE_TYPES, by index): the sum x through it, m its memory.
float neuron(int k, float rate, float x, inout float m) {
  float a = 1.0 - exp(-clamp(rate, 0.1, 10.0) * u_dt);
  if (k == 1) { m = x >= 1.0 ? 1.0 : (x <= 0.0 ? 0.0 : m); return m; }
  if (k == 2) { m += (x - m) * a; return m; }
  if (k == 3) { float y = x - m; m += (x - m) * a; return y; }
  m = 0.0;
  return x;
}
// Random numbers: an integer hash (PCG) of the midge and the step.
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
  bool alive = mode == ${MODE.flying.toFixed(1)} || mode == ${MODE.down.toFixed(1)} || mode == ${MODE.onFlower.toFixed(1)};
  // A negative vision sees nothing; the lower it is the less it sees (GROUND_VISION at 0 px, all of it from FULL_VISION_Z up).
  float RANGE = alive ? max(G_VISION, 0.0) * mix(GROUND_VISION, 1.0, clamp(vert.x / FULL_VISION_Z, 0.0, 1.0)) : 0.0;
  vec4 traits = texelFetch(u_traits, own, 0);
  float seed = traits.x;
  float zMe = vert.x;
  // What it sees, each kind summed: (its way in 3D x closeness, the sum of
  // the closenesses). sHead: the midges' velocities less its own x
  // closeness, and (w) the brightness where it is.
  int n = 0;
  vec4 sPos = vec4(0.0);
  vec4 sHead = vec4(0.0, 0.0, 0.0, 1.0);
  vec4 iPads = vec4(0.0);
  vec4 iScum = vec4(0.0);
  vec4 iCol = vec4(0.0);
  vec3 seekCol = clamp(vec3(G_SEEK_RED, G_SEEK_GREEN, G_SEEK_BLUE), 0.0, 1.0); // its colour gene (past 0..1 counts as the end)
  // A thing at the water or ground (d: its way in x, y), within its vision in 3D: (its way x closeness, closeness).
  // Sideways only: its height is its own (flight height gene); seen in 3D (how near counts its height).
  #define itemWay(d) (way3(vec3(d, -zMe)) * vec4(1.0, 1.0, 0.0, 1.0))
  #define way3(d3) (length(d3) <= RANGE ? vec4((d3) / max(length(d3), 1.0), 1.0) * (1.0 - length(d3) / RANGE) : vec4(0.0))
  #define seeItem(d, id, coloured) { vec4 c_ = itemWay(d); if (coloured) iCol += c_ * max(0.0, 1.0 - distance(flowerColour(id), seekCol) / COLOUR_TOLERANCE); else iScum += c_; }
`,
    sense: /* glsl */ `
  // Brightness: how much sun reaches it, right where it is.
  if (alive && u_cloudsOn) sHead.w = 1.0 - cloudCover(pos);`,
    visit: /* glsl */ `
        {
          vec4 nv = texelFetch(u_vert, coordOf(int(texelFetch(u_sortedKeys, nbAt, 0).x & ID_MASK)), 0);
          vec3 d3 = vec3(d, nv.x - zMe);
          vec4 c = way3(d3);
          if (c.w > 0.0) {
            n++;
            sPos += c;
            sHead.xyz += (vec3(nb.zw, nv.y) - vec3(vel, vert.y)) * c.w;
          }
        }`,
    act: /* glsl */ `
  float energy = min(aux.x, u_energyMax); // e
  float tag = aux.z;
  float z = vert.x; // height above the water (px)
  float vz = vert.y;
  float bodyTime = u_bodyTime * (0.7 + 0.6 * fract(seed * 91.7)); // its own (render/shaders.js midgeVS reads it back for the ripple)
  float ageNow = max(0.0, u_time - traits.y);
  // Noise: a random number each step, uniform in −1..1 (averaging 0).
  uint hs = pcg(floatBitsToUint(seed) ^ pcg(floatBitsToUint(u_time)));
  float noiseAmt = unit(pcg(hs + 3u)) * 2.0 - 1.0;
  // Noise: direction. A random heading per midge, eased from one random
  // angle to the next every 1 / (its wander rate gene) s (value noise in time, offset
  // by its seed, so no two midges turn together).
  float wx = u_time * max(${geneMacro('wanderRate')}, 0.0) + seed * 977.0;
  float wi = floor(wx);
  float wf = fract(wx);
  uint ws = pcg(floatBitsToUint(seed) + 11u);
  // Turning the shorter way from one random heading to the next: every
  // direction equally likely (blending the two angles as numbers would
  // favour the middle of 0..2π, leftwards).
  float wa0 = unit(pcg(ws ^ uint(int(wi)))) * 6.2832;
  float wd = unit(pcg(ws ^ uint(int(wi) + 1))) * 6.2832 - wa0;
  wd -= 6.2832 * floor(wd / 6.2832 + 0.5);
  float wa = wa0 + wd * wf * wf * (3.0 - 2.0 * wf);
  vec2 wanderDir = vec2(cos(wa), sin(wa));
  // Its latches (LATCHES): bits of aux.w's fraction (its generation the whole part); 0 unless alive.
${LATCHES.map((l, k) => `  float ${latchVar(l)} = alive ? mod(floor(fract(aux.w) * ${2 ** (k + 1)}.0), 2.0) : 0.0;`).join('\n')}
  // Its wiring, worked out only while it is alive (an egg, a body or an
  // empty slot has no brain: steering, eat and lay stay 0, and no links).
  vec3 steer = vec3(0.0);
  float eatOut = 0.0;
  float layOut = 0.0;
  int links = 0; // how many links its wiring has (each costs energy)
  vec3 sIn[NI];
  float eIn[NI];
  float lIn[NI];
  for (int i = 0; i < NI; i++) {
    sIn[i] = vec3(0.0);
    eIn[i] = 0.0;
    lIn[i] = 0.0;
  }
  if (alive) {
${BRAIN_GLSL}
  }
  // The eat and lay neurons (memory in vert.z, vert.w; 0 unless alive).
  float eatSum = eatOut;
  float laySum = layOut;
  float memEat = alive ? vert.z : 0.0;
  float memLay = alive ? vert.w : 0.0;
  eatOut = neuron(int(${geneMacro(nodeKey('eat'))}), ${geneMacro(rateKey('eat'))}, eatSum, memEat);
  layOut = neuron(int(${geneMacro(nodeKey('lay'))}), ${geneMacro(rateKey('lay'))}, laySum, memLay);
  if (!alive) { memEat = 0.0; memLay = 0.0; }
  bool wantEat = eatOut > 0.0 && eatOut >= layOut;
  bool wantLay = layOut > 0.0 && layOut > eatOut;
  // Metabolism (energy per s): its body's base burn, what flight adds
  // (growing with the square of its speed; nothing down), and its wiring's
  // (neural), always.
  float baseRate = 0.0;
  float flightRate = 0.0;
  float nl = float(links);
  float neuralRate = u_linkGrowth > 1.0001 ? u_linkCost * (pow(u_linkGrowth, nl) - 1.0) / (u_linkGrowth - 1.0) : u_linkCost * nl;
  vec2 fDrag = vec2(0.0);
  vec2 fBrake = vec2(0.0);
  vec2 fDrift = vec2(0.0);
  vec2 fTotal = vec2(0.0);
  float fHold = 0.0;   // px/s²: the height hold's push (up +)
  float maxS = 0.0;    // its speed cap now (its max speed gene, slower past its lifespan)
  float capped = 0.0;  // 1 while the cap holds it back
  float blocked = 0.0; // 1 while the map's edge, the ground or the ceiling stops it

  if (mode == ${MODE.egg.toFixed(1)}) {
    // An egg on the scum: ripening until its hatching time (traits.y), then a midge.
    tag = clamp(1.0 - (traits.y - u_time) / max(u_hatchTime, 1e-3), 0.0, 1.0);
    vel = vec2(0.0);
    if (u_time >= traits.y) {
      mode = ${MODE.flying.toFixed(1)};
      tag = -1.0;
      z = 1.0;
      vz = 0.0;
      float a = unit(pcg(floatBitsToUint(seed) ^ pcg(floatBitsToUint(u_time)))) * 6.2832;
      vel = vec2(cos(a), sin(a)) * max(G_MAX_SPEED, 0.0) * 0.5;
    }
  } else if (mode == ${MODE.falling.toFixed(1)}) {
    // Starved: dropping to the water or ground (off its flower, if it died on one).
    vz = -FALL_SPEED;
    z -= FALL_SPEED * u_dt;
    pos += u_wind * 0.3 * u_dt;
    if (z <= 0.0) { z = 0.0; vz = 0.0; mode = ${MODE.dead.toFixed(1)}; tag = bodyTime; }
  } else if (mode == ${MODE.dead.toFixed(1)}) {
    tag -= u_dt;
    if (tag <= 0.0) mode = ${MODE.empty.toFixed(1)};
  } else if (alive) {
    bool flying = mode == ${MODE.flying.toFixed(1)};
    // Past its lifespan, every second slower and hungrier (compounding).
    float over = max(0.0, ageNow - u_lifespan);
    float ageSpeed = pow(u_ageSlow, over);
    float ageBurn = pow(u_ageBurn, over);
    vec3 v3 = vec3(vel, vz);
    baseRate = u_baseBurn * ageBurn;
    flightRate = flying ? u_burn * ageBurn * dot(v3, v3) / (COST_SPEED * COST_SPEED) : 0.0;
    energy -= (baseRate + flightRate + neuralRate) * u_dt;
    bool onFlower = mode == ${MODE.onFlower.toFixed(1)};
    bool open = onFlower && flowerOpen(tag);
    if (open) energy = min(u_energyMax, energy + u_feedRate * u_dt);
    if (energy <= 0.0) {
      // Starved (of old age, past its lifespan): down it goes.
      energy = 0.0;
      aux1.w = over > 0.0 ? ${DEATH.old.toFixed(1)} : ${DEATH.starved.toFixed(1)};
      mode = ${MODE.falling.toFixed(1)};
      if (!flying) { z = 2.0; tag = -1.0; }
    } else if (!flying) {
      // Down on the water or the ground, while eating or laying is on.
      vel = vec2(0.0);
      z = 0.0;
      vz = 0.0;
      if (!wantEat && !wantLay) {
        // Neither on: it takes off only with lift (its steering plus its height hold pushing up),
        // rising by its first step of climb at once (never flying at 0 px);
        // else it rests here.
        fHold = HEIGHT_PULL * max(G_FLY_HEIGHT, 0.0);
        float lift = steer.z + fHold;
        mode = lift > 0.0 ? ${MODE.flying.toFixed(1)} : ${MODE.down.toFixed(1)};
        if (lift > 0.0) { vz = lift * u_dt; z = vz * u_dt; }
        tag = -1.0;
      } else if (wantEat) {
        // Eating: on an open flower it drinks; off one (or once it runs dry) it eats nothing, until one under it opens.
        if (!open) {
          float f = itemUnder(pos, CONTACT, true);
          mode = f >= 0.0 ? ${MODE.onFlower.toFixed(1)} : ${MODE.down.toFixed(1)};
          tag = f;
        }
      } else {
        // Laying: a clutch, if it has the energy for one and its last was read; on scum the eggs are placed, elsewhere wasted.
        mode = ${MODE.down.toFixed(1)};
        tag = -1.0;
        // How many eggs: its clutch gene's whole number, one more by chance by
        // the fraction (1..MAX_CLUTCH). It costs the clutch's energy (shared by
        // the hatchlings) plus u_eggCost per egg (spent on the eggs themselves).
        float size = G_CLUTCH;
        float eggs = clamp(floor(size) + (unit(pcg(floatBitsToUint(seed) ^ pcg(floatBitsToUint(u_time) + 7u))) < fract(size) ? 1.0 : 0.0), 1.0, float(MAX_CLUTCH));
        float cost = max(G_EGG_ENERGY, MIN_CLUTCH_ENERGY) + u_eggCost * eggs;
        if (energy > cost && aux1.x < u_eggAck) {
          energy -= cost;
          aux1.xyz = itemUnder(pos, LAY_CONTACT, false) >= 0.0 ? vec3(u_time, pos) : vec3(u_time, -1.0, -1.0);
          aux1.w = eggs; // read by engine/Laying.js (while alive; at death it holds the cause)
        }
      }
    } else {
      maxS = max(G_MAX_SPEED, 0.0) * ageSpeed;
      if (wantEat || wantLay) {
        // Coming down to eat or lay: it glides in, its steering acting
        // sideways at GLIDE_STEER, braking, its sink easing to DESCEND.
        fBrake = -vel * DOWN_BRAKE;
        v3.xy += (steer.xy * GLIDE_STEER + fBrake) * u_dt;
        v3.z += (-DESCEND - v3.z) * min(1.0, SINK_RATE * u_dt);
        fTotal = steer.xy * GLIDE_STEER + fBrake;
      } else {
        // Steering drives it, the height hold keeps it near its flight
        // height (damped), and air drag slows it.
        fHold = HEIGHT_PULL * (max(G_FLY_HEIGHT, 0.0) - z) - HEIGHT_DAMP * v3.z;
        fDrag = -vel * DRAG;
        v3 += (steer + vec3(0.0, 0.0, fHold) - v3 * DRAG) * u_dt;
        fTotal = steer.xy + fDrag;
      }
      float sp = length(v3);
      if (sp > maxS) { v3 *= maxS / max(sp, 1e-6); capped = 1.0; }
      // The wind carries it, harder higher up, less in the lee of plants and trunks.
      fDrift = u_wind * (1.0 - shelterAt(pos - u_wind * 0.5)) * (0.35 + 0.65 * min(z / 10.0, 1.5));
      vec2 next = pos + (v3.xy + fDrift) * u_dt;
      // The map's edge stops it (its way out lost), as do the water and the ceiling.
      if (next.x < 0.0 || next.x > u_world.x) { v3.x = 0.0; blocked = 1.0; }
      if (next.y < 0.0 || next.y > u_world.y) { v3.y = 0.0; blocked = 1.0; }
      pos = clamp(next, vec2(0.0), u_world);
      z += v3.z * u_dt;
      if (z <= 0.0) { z = 0.0; if (v3.z < 0.0) blocked = 1.0; v3.z = max(v3.z, 0.0); }
      if (z >= MAX_Z) { z = MAX_Z; if (v3.z > 0.0) blocked = 1.0; v3.z = min(v3.z, 0.0); }
      vel = v3.xy;
      vz = v3.z;
      if (u_rain > 0.0 && hitByRain(pos, z)) {
        // A raindrop falling through it: down it goes.
        aux1.w = ${DEATH.rain.toFixed(1)};
        mode = ${MODE.falling.toFixed(1)};
      } else if (z <= 0.0 && (wantEat || wantLay || v3.z <= 0.0)) {
        // Down: it stays (the next step eats or lays), or, at 0 px with no
        // lift (not rising), it cannot fly: it rests here.
        mode = ${MODE.down.toFixed(1)};
        tag = -1.0;
        vel = vec2(0.0);
        vz = 0.0;
      }
    }
  }
  o_state = vec4(pos, vel);
  o_aux = vec4(energy, mode, tag, floor(aux.w)${LATCHES.map((l, k) => ` + ${latchVar(l)} * ${(2 ** -(k + 1)).toFixed(4)}`).join('')});
  o_vert = vec4(z, vz, memEat, memLay);
  o_aux1 = aux1;`,
  },
}
