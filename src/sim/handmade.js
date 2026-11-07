import { ACTIVATIONS, activationKey, gateInputKey, gateKey, GATES, gateThresholdKey, IRIS_YELLOW, LATCHES, latchKeys, linkBit, MIDGE_GENES, MIDGE_INPUTS, MIDGE_OUTPUTS, NODE_TYPES, nodeKey, rateKey, weightKey, wiresFrom } from '../species/midges.js'

/**
 * Hand-made midge brains: a compact spec turned into a full genes object
 * (every gene of species/midges.js). Used by the Brain tab's examples and the
 * profile editor's presets.
 *
 * spec: { body: { gene: value }, links: [[input key, output key, activation
 * key, { element: weight }, gate?: [gate key, gate input key, threshold?]]],
 * nodes: { output: [neuron type key, rate] }, latches: { latch key: { by:
 * input key, on, off } } }. Genes not given: body and brain genes at their
 * default (or the middle of their range), every weight 0, every activation
 * linear, no gates (threshold ½), neurons plain, no links.
 */
export function handmadeGenes(spec) {
  const genes = Object.fromEntries(MIDGE_GENES.map((g) => [g.key, g.weight || g.activation || g.wires ? 0 : (g.default ?? (g.min + g.max) / 2)]))
  Object.assign(genes, { vision: 80, maxSpeed: 70, clutch: 2 }, spec.body ?? {})
  const bits = []
  for (const [inKey, outKey, act, weights, gate] of spec.links ?? []) {
    const i = MIDGE_INPUTS.findIndex((input) => input.key === inKey)
    const o = MIDGE_OUTPUTS.findIndex((out) => out.key === outKey)
    if (i < 0 || o < 0) throw new Error(`No link ${inKey} → ${outKey}`)
    bits.push(linkBit(i, o))
    genes[activationKey(i, o)] = Math.max(0, ACTIVATIONS.findIndex((a) => a.key === act))
    for (const [el, w] of Object.entries(weights)) genes[weightKey(i, el, o)] = w
    if (gate) {
      const [type, by, t] = gate
      const k = GATES.findIndex((g) => g.key === type)
      const j = MIDGE_INPUTS.findIndex((input) => input.key === by)
      if (k < 0 || j < 0) throw new Error(`No gate ${type} by ${by}`)
      genes[gateKey(i, o)] = k
      genes[gateInputKey(i, o)] = j
      if (t != null) genes[gateThresholdKey(i, o)] = t
    }
  }
  for (const [key, { by, on, off }] of Object.entries(spec.latches ?? {})) {
    const l = LATCHES.find((x) => x.key === key)
    const j = MIDGE_INPUTS.findIndex((input) => input.key === by)
    if (!l || j < 0) throw new Error(`No latch ${key} on ${by}`)
    const k = latchKeys(l)
    Object.assign(genes, { [k.src]: j, [k.on]: on, [k.off]: off })
  }
  for (const [out, [type, rate]] of Object.entries(spec.nodes ?? {})) {
    genes[nodeKey(out)] = Math.max(0, NODE_TYPES.findIndex((n) => n.key === type))
    genes[rateKey(out)] = rate
  }
  return { ...genes, ...wiresFrom(bits) }
}

/**
 * test_01: feed when low, lay when high, with the flat wiring only (links,
 * weights, activations, the constant 1 as a bias; plain neurons).
 *
 * E: energy (0..1 full). C: the coloured things in view (iris heads near
 * its colour gene, each by how near its colour is: about 0.7..1 fresh, 0
 * withered; pickerelweed and cattails not at all) times closeness (1 on it,
 * 0 at the edge of its 20 px vision), summed. S: the scum in view (the sum of
 * the closenesses).
 *
 * - Steering: to the flowers (C's direction, tanh) and the scum (tanh,
 *   weaker), noise to roam, its own velocity to keep going. Not scaled by
 *   energy (made before links had gates).
 * - eat = 2.7 C + gauss(2.5 E) − 3. gauss(2.5 E) is the hunger term: about 1
 *   when empty, 0.37 at E 0.4, near 0 from E 0.6. So eat is on only right
 *   beside a flower (closeness about 0.8 and up: within ~4 px) and only
 *   when hungry, and never when full. The short vision keeps C to the one
 *   flower it is at (flowers are about 30 px apart in a patch).
 * - lay = tanh(0.4 S) + 2.5 E − 3: on over a scum mat (tanh near 1) once E
 *   is above about 0.8; near a mat's edge (S small) it would need E above 1,
 *   so never.
 * Eat and lay take turns by energy: hungry, lay is off; full, eat is off.
 *
 * Tried in the sim (300 exact copies, before the colour gene, when C was
 * by red, green and blue weights): it laid on scum, but fed poorly: a hungry
 * midge often came down a few px short of a flower and, eating nothing
 * there, stayed down while eat was on. Not tried since.
 */
export const TEST_01 = {
  name: 'test_01',
  text: 'Feeds when low, lays when high. Eat (2.7 × colour + gauss(2.5 E) − 3): on only right beside a flower and only when hungry. Lay (tanh(0.4 scum) + 2.5 E − 3): on over a scum mat above 0.8 energy. Steering always pulls to flowers and scum (made before gates; see the gated forager for steering switched by energy). Before the colour gene it laid well but often landed just short of a flower and starved there.',
  body: { vision: 20, maxSpeed: 60, eggEnergy: 0.3, clutch: 2 },
  links: [
    ['colour', 'steer', 'tanh', { where: 2.7 }],
    ['scum', 'steer', 'tanh', { where: 0.25 }],
    ['noise', 'steer', 'linear', { value: 0.4 }],
    ['self', 'steer', 'tanh', { velocity: 0.3 }],
    ['colour', 'eat', 'linear', { where: 2.7 }],
    ['energy', 'eat', 'gauss', { value: 2.5 }],
    ['bias', 'eat', 'linear', { value: -3 }],
    ['scum', 'lay', 'tanh', { where: 0.4 }],
    ['energy', 'lay', 'linear', { value: 2.5 }],
    ['bias', 'lay', 'linear', { value: -3 }],
  ],
}

/**
 * The eat–lay cycler: a template brain for the latch, the gates and noise:
 * direction, made by hand to evolve from (not tuned for survival).
 *
 * Its latch is "full": on when energy reaches 0.9, off when it is down to
 * 0.5. Not full, it hunts flowers; full, it flies off and lays on scum,
 * until two clutches have spent it down to 0.5; then it hunts again.
 *
 * - Steering: coloured things FLIP latch (pull while not full, push away
 *   while full: it leaves the flower patch), scum IF latch (only while
 *   full), and noise: direction to roam when nothing pulls.
 * - Eat: step(coloured things) UNLESS latch − 0.5: on with any flower in
 *   view while not full. Lay: step(scum) IF latch − 0.5: on with any scum
 *   in view while full.
 * - Vision 40 px: on the ground it sees 4 px (GROUND_VISION), about as far
 *   as it must be to drink (4 px) or lay on scum (5 px). So down, seeing a
 *   flower means touching one: it stays and drinks until full (or the head
 *   withers out of view); missing, eat goes off, it hops up, sees it again
 *   and comes down nearer (its steering still pulls while it glides).
 * - Clutches: 0.9 e each, two hatchlings, plus the per-egg cost: from 0.9
 *   full, two clutches bring it below 0.5, which ends "full".
 */
export const CYCLER = {
  name: 'Eat–lay cycler',
  text: 'A template to evolve from: its latch is “full” (energy on at 0.9, off at 0.5). Not full: pulled to flowers, eats on any flower in view (step), scum ignored. Full: FLIP pushes it away from flowers, IF pulls it to scum, lays on any scum in view, two clutches spend it back to 0.5. Noise: direction makes it roam when nothing is in view. Vision 40 px, so on the ground it sees about as far as it must touch (4 px): seeing a flower there means it is on one. Not tuned for survival.',
  // Its colour gene: iris yellow (the flowers it is made to feed on).
  body: { vision: 40, maxSpeed: 70, flyHeight: 10, eggEnergy: 0.9, clutch: 2, wanderRate: 0.5, seekRed: IRIS_YELLOW[0], seekGreen: IRIS_YELLOW[1], seekBlue: IRIS_YELLOW[2] },
  latches: { latch: { by: 'energy', on: 0.9, off: 0.5 } },
  links: [
    ['colour', 'steer', 'tanh', { where: 2.5 }, ['flip', 'latch', 0.5]],
    ['scum', 'steer', 'tanh', { where: 1.5 }, ['if', 'latch', 0.5]],
    ['wander', 'steer', 'tanh', { where: 0.4 }],
    ['colour', 'eat', 'step', { where: 1 }, ['unless', 'latch', 0.5]],
    ['bias', 'eat', 'linear', { value: -0.5 }],
    ['scum', 'lay', 'step', { where: 1 }, ['if', 'latch', 0.5]],
    ['bias', 'lay', 'linear', { value: -0.5 }],
  ],
}

/** Presets the profile editor can start from. */
export const PRESETS = [CYCLER, TEST_01]
