import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ACTIVATIONS, gateFactor, GATES, INPUT_DOCS, linkBit, MIDGE_INPUTS, MIDGE_OUTPUTS, NODE_TYPES, OUTPUT_DOCS, RANK } from '../species/midges.js'
import { CYCLER, handmadeGenes, TEST_01 } from '../sim/handmade.js'
import { Slider } from './controls.jsx'
import { button } from './evolution.jsx'
import { BrainFacts, WiringDiagram } from './MidgePanel.jsx'

/**
 * The brain guide (a wide modal, BrainModal): a reference for how a midge's wiring computes. Every
 * activation function a link can have (the ones in the sim, and those of a
 * NEAT-style brain with node memory, not in the sim), drawn; every logic
 * gate a link can have (GATES), drawn as its factor g against its gate
 * input m; a few
 * hand-made example wirings, drawn as the Midges tab draws them and
 * spawnable; and a toy NEAT brain with a memory node, simulated here.
 */

/**
 * Activation functions. `f(x)`: stateless, drawn as a curve. `step(x, s, dt)`:
 * with memory (s: { x, y } last step's input and output), drawn as its
 * response over time to a test input. `inSim`: a link can have it now.
 */
const SIM_FNS = {
  linear: (x) => x,
  step: (x) => (x > 0 ? 1 : 0),
  tanh: Math.tanh,
  relu: (x) => Math.max(x, 0),
  gauss: (x) => Math.exp(-x * x),
  sine: Math.sin,
  sigmoid: (x) => 1 / (1 + Math.exp(-x)),
  abs: Math.abs,
}
const SIM_FORMULA = { linear: 'y = x', step: 'y = 1 if x > 0, else 0', tanh: 'y = tanh x', relu: 'y = max(x, 0)', gauss: 'y = e^(−x²)', sine: 'y = sin x', sigmoid: 'y = 1 / (1 + e^(−x))', abs: 'y = |x|' }

/** The output neurons (species/midges.js neuron, the same maths), at rate 1 /s. */
const NODE_RATE = 1
const NODE_STEP = {
  plain: (x) => ({ y: x, m: 0 }),
  latch: (x, m) => {
    const y = x >= 1 ? 1 : x <= 0 ? 0 : m
    return { y, m: y }
  },
  smooth: (x, m, dt) => {
    const next = m + (x - m) * (1 - Math.exp(-NODE_RATE * dt))
    return { y: next, m: next }
  },
  change: (x, m, dt) => ({ y: x - m, m: m + (x - m) * (1 - Math.exp(-NODE_RATE * dt)) }),
}
const NODE_FORMULA = { plain: 'y = x', latch: 'on at x ≥ 1, off at x ≤ 0', smooth: 'm → x at its rate; y = m', change: 'm → x at its rate; y = x − m' }

/** SoftLatch (rate b): exponential glide toward 1 as the input rises, toward 0 as it falls, anchored at the last (input, output). */
function softLatch(x, s, b) {
  if (x >= 0.999) return 1
  if (x <= 0.001) return 0
  const xp = s.x >= 0.999 ? 1 : s.x <= 0.001 ? 0 : s.x
  if (x < xp) return (s.y * (1 - Math.exp(-b * x))) / (1 - Math.exp(-b * xp))
  const e = Math.exp(b * (xp - 1))
  const A = (s.y - e) / (1 - e)
  return A + (1 - A) * Math.exp(b * (x - 1))
}

const FUNCTIONS = [
  ...ACTIVATIONS.map((a) => ({ key: a.key, label: a.label, formula: SIM_FORMULA[a.key], hint: a.hint, f: SIM_FNS[a.key], inSim: true })),
  { key: 'lorentz', label: 'Lorentzian', formula: 'y = 1 / (1 + x²)', hint: 'the NEAT design’s “Gaussian”: also 1 at 0, but with long tails (it fades much more slowly than e^(−x²))', f: (x) => 1 / (1 + x * x) },
  { key: 'mult', label: 'mult', formula: 'y = b · Π wᵢ·yᵢ', hint: 'multiplies its inputs: a gate, one input switching another on or off (the sim’s AND gate is this for a link and one gate input, clamped to 0..1). Drawn: x times a second input at 1, ½, 0 and −1', f: (x) => x, mult: [1, 0.5, 0, -1] },
  { key: 'softlatch', label: 'soft latch (b = 6)', formula: 'glides toward 1 as x rises, toward 0 as it falls', hint: 'a smooth latch: small b glides, large b snaps like a latch', step: (x, s) => softLatch(x, s, 6) },
  { key: 'integrator', label: 'integrator', formula: 'y = y(t−1) + x·Δt', hint: 'adds its input up over time, with no leak: a running total (a timer, a tally)', step: (x, s, dt) => s.y + x * dt },
  { key: 'differential', label: 'differential', formula: 'y = (x(t) − x(t−1)) / Δt', hint: 'how fast its input changes: spikes when it moves, 0 while it holds', step: (x, s, dt) => (x - s.x) / dt },
  { key: 'inhibitory', label: 'inhibitory (b = 1)', formula: 'y = Δx + y(t−1)·e^(−b·Δt)', hint: 'reacts to a change and fades back to 0 at rate b: gets used to a steady input (habituation)', step: (x, s, dt) => x - s.x + s.y * Math.exp(-1 * dt) },
]

/** The output neuron types, drawn like the functions with memory (their memory m in s.m). */
const NEURONS = NODE_TYPES.map((n) => ({
  key: `node-${n.key}`,
  label: n.key === 'smooth' || n.key === 'change' ? `${n.label} (rate ${NODE_RATE}/s)` : n.label,
  formula: NODE_FORMULA[n.key],
  hint: n.hint,
  inSim: true,
  step: (x, s, dt) => {
    const r = NODE_STEP[n.key](x, s.m ?? 0, dt)
    s.m = r.m
    return r.y
  },
}))

/** The test input the functions with memory are drawn against (t in s, 0..10): a rise, a hold, a dip, a pulse. */
const T_END = 10
const DT = 0.05
function testInput(t) {
  if (t < 1) return 0
  if (t < 3) return ((t - 1) / 2) * 1.2
  if (t < 5) return 1.2
  if (t < 6.5) return 0.5
  if (t < 8) return 0
  if (t < 8.5) return 1.2
  return 0.3
}
function respond(fn) {
  const pts = []
  const s = { x: 0, y: 0 }
  for (let t = 0; t <= T_END + 1e-9; t += DT) {
    const x = testInput(t)
    const y = fn.step(x, s, DT)
    pts.push([t, x, y])
    s.x = x
    s.y = y
  }
  return pts
}

const W = 120
const H = 66
const Y_LIM = 1.6
const clampY = (y) => Math.max(-Y_LIM, Math.min(Y_LIM, y))
const sy = (y) => H / 2 - (clampY(y) / Y_LIM) * (H / 2 - 3)
const path = (pts) => pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${sy(y).toFixed(1)}`).join('')

/** A function's picture: its curve over x in −4..4 (a dot at x), or its response over time to the test input. */
function FnPlot({ fn, x }) {
  const X_LIM = 4
  const sx = (v) => ((v + X_LIM) / (2 * X_LIM)) * W
  const axes = (
    <>
      <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke="#334155" strokeWidth={0.5} />
      <line x1={0} y1={sy(1)} x2={W} y2={sy(1)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="1.5 1.5" />
      <line x1={0} y1={sy(-1)} x2={W} y2={sy(-1)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="1.5 1.5" />
    </>
  )
  if (fn.step) {
    const pts = respond(fn)
    const tx = (t) => (t / T_END) * W
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${fn.label}: its response over time to a test input`}>
        {axes}
        <path d={path(pts.map(([t, xi]) => [tx(t), xi]))} fill="none" stroke="#64748b" strokeWidth={0.8} strokeDasharray="2 1.2" />
        <path d={path(pts.map(([t, , y]) => [tx(t), y]))} fill="none" stroke={fn.inSim ? '#4ade80' : '#fbbf24'} strokeWidth={1.2} />
      </svg>
    )
  }
  const xs = Array.from({ length: 161 }, (_, k) => -X_LIM + (k / 160) * 2 * X_LIM)
  const curves = fn.mult ? fn.mult.map((k) => xs.map((v) => [sx(v), v * k])) : [xs.map((v) => [sx(v), fn.f(v)])]
  const y = fn.mult ? x : fn.f(x)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${fn.label}: y against x from −4 to 4`}>
      {axes}
      <line x1={sx(0)} y1={0} x2={sx(0)} y2={H} stroke="#334155" strokeWidth={0.5} />
      {curves.map((c, k) => (
        <path key={k} d={path(c)} fill="none" stroke={fn.inSim ? '#4ade80' : '#fbbf24'} strokeWidth={1.2} strokeOpacity={fn.mult ? 1 - k * 0.2 : 1} />
      ))}
      <circle cx={sx(x)} cy={sy(y)} r={2} fill="#f8fafc" />
    </svg>
  )
}

/** A gate's picture: its factor g (−1..1) against its gate input m, over −0.25..1.25 (clamped to 0..1 inside), threshold t, a dot at m. */
function GatePlot({ k, m, t }) {
  const M0 = -0.25
  const M1 = 1.25
  const sx = (v) => ((v - M0) / (M1 - M0)) * W
  const gy = (g) => H / 2 - g * (H / 2 - 5)
  const ms = Array.from({ length: 151 }, (_, j) => M0 + (j / 150) * (M1 - M0))
  const d = ms.map((v, j) => `${j ? 'L' : 'M'}${sx(v).toFixed(1)},${gy(gateFactor(k, v, t)).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${GATES[k].label}: its factor g against its gate input m from −0.25 to 1.25`}>
      <line x1={0} y1={gy(0)} x2={W} y2={gy(0)} stroke="#334155" strokeWidth={0.5} />
      <line x1={0} y1={gy(1)} x2={W} y2={gy(1)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="1.5 1.5" />
      <line x1={0} y1={gy(-1)} x2={W} y2={gy(-1)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="1.5 1.5" />
      {GATES[k].threshold && <line x1={sx(t)} y1={0} x2={sx(t)} y2={H} stroke="#78350f" strokeWidth={0.6} strokeDasharray="2 1" />}
      <line x1={sx(0)} y1={0} x2={sx(0)} y2={H} stroke="#334155" strokeWidth={0.5} />
      <line x1={sx(1)} y1={0} x2={sx(1)} y2={H} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="1.5 1.5" />
      <path d={d} fill="none" stroke="#fbbf24" strokeWidth={1.2} />
      <circle cx={sx(m)} cy={gy(gateFactor(k, m, t))} r={2} fill="#f8fafc" />
    </svg>
  )
}

function GateCard({ k, m, t }) {
  const g = GATES[k]
  return (
    <div className="rounded-md bg-slate-800/60 p-1.5" title={g.hint}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11px] text-amber-300">{g.label}</span>
        <span className="font-mono text-[10px] tabular-nums text-slate-400">g {gateFactor(k, m, t).toFixed(2)}</span>
      </div>
      <GatePlot k={k} m={m} t={t} />
      <div className="font-mono text-[9px] leading-tight text-slate-400">{g.formula}</div>
      <div className="mt-0.5 text-[9px] leading-tight text-slate-500">{g.hint}</div>
    </div>
  )
}

function FnCard({ fn, x }) {
  const y = fn.f && !fn.mult ? fn.f(x) : null
  return (
    <div className="rounded-md bg-slate-800/60 p-1.5" title={fn.hint}>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`text-[11px] ${fn.inSim ? 'text-green-300' : 'text-amber-300'}`}>{fn.label}</span>
        {y != null && <span className="font-mono text-[10px] tabular-nums text-slate-400">{y.toFixed(2)}</span>}
      </div>
      <FnPlot fn={fn} x={x} />
      <div className="font-mono text-[9px] leading-tight text-slate-400">{fn.formula}</div>
      <div className="mt-0.5 text-[9px] leading-tight text-slate-500">{fn.hint}</div>
    </div>
  )
}

/**
 * Example wirings, made by hand to show what the wiring can express (not
 * tuned or tested for survival). `links`: [input key, output key,
 * activation key, { element: weight }].
 */
const EXAMPLES = [
  {
    name: 'Empty',
    text: 'No links: no steering, so drag slows it to a halt, and it never eats or lays. It pays nothing for wiring. Every other brain is measured against this one.',
    links: [],
  },
  {
    name: 'Cruiser',
    text: 'Its own velocity pushes along it, keeping it going against the drag, at its flight height (its gene holds it there). It flies straight wherever the wind turns it. Noise (the scalar) only jiggles it up and down about its height; to turn at random it would need noise: direction. It never eats.',
    links: [
      ['self', 'steer', 'tanh', { velocity: 0.4 }],
      ['noise', 'steer', 'linear', { value: 0.3 }],
    ],
  },
  {
    name: 'Swarmer',
    text: 'Towards other midges (where) and matching their heading, the classic boid rules of cohesion and alignment, plus a little noise. There is no separation rule: the flat wiring has no input for “too close”, though a Gaussian on “where” comes near (strongest when the pull is small).',
    links: [
      ['midges', 'steer', 'tanh', { where: 0.6, heading: 0.5 }],
      ['self', 'steer', 'tanh', { velocity: 0.3 }],
      ['noise', 'steer', 'linear', { value: 0.4 }],
    ],
  },
  {
    name: 'Forager',
    text: 'Flies to coloured things, and eats when one is close and it is hungry: eat = 3.5 × coloured things − 1.2 × energy (coloured things: iris heads near its colour gene, by how near and how fresh), so a full midge stays up and a hungry one lands. Without a bias link (constant 1), the threshold sits at 0: “eat only when hungry” needs energy as a second, negative input.',
    links: [
      ['colour', 'steer', 'tanh', { where: 2.5 }],
      ['colour', 'eat', 'linear', { where: 3.5 }],
      ['energy', 'eat', 'linear', { value: -1.2 }],
      ['self', 'steer', 'tanh', { velocity: 0.4 }],
      ['noise', 'steer', 'linear', { value: 0.4 }],
    ],
  },
  {
    name: 'Latched forager',
    text: 'The forager with a latch on its eat neuron and a bias (constant 1). The latch’s sum is 0.8 + 1.2 × colour − 2 × energy. Right beside a fresh iris (colour near 1) it switches on once energy is down to about 0.3, then stays on until energy is back to about 0.9: it drinks until nearly full instead of stopping after a sip. Away from flowers it never switches on. Not tuned: if its flower runs dry it waits there. Its memory shows live as m under eat.',
    nodes: { eat: ['latch', 1] },
    links: [
      ['colour', 'steer', 'tanh', { where: 2.5 }],
      ['colour', 'eat', 'linear', { where: 1.2 }],
      ['energy', 'eat', 'linear', { value: -2 }],
      ['bias', 'eat', 'linear', { value: 0.8 }],
      ['self', 'steer', 'tanh', { velocity: 0.4 }],
      ['noise', 'steer', 'linear', { value: 0.4 }],
    ],
  },
  {
    name: 'Forager and layer',
    text: 'The forager, plus: drawn to scum, and lays when it sees scum (step: on at any amount). Laying wins over eating only when lay is the larger, so a full midge near scum lays, a hungry one near flowers eats. Its steering has no gates, so it is drawn to scum even when hungry: the gated forager below fixes that.',
    links: [
      ['colour', 'steer', 'tanh', { where: 2.5 }],
      ['colour', 'eat', 'linear', { where: 3.5 }],
      ['energy', 'eat', 'linear', { value: -1.2 }],
      ['scum', 'steer', 'tanh', { where: 0.6 }],
      ['scum', 'lay', 'step', { where: 1.0 }],
      ['energy', 'lay', 'linear', { value: 0.3 }],
      ['self', 'steer', 'tanh', { velocity: 0.4 }],
      ['noise', 'steer', 'linear', { value: 0.4 }],
    ],
  },
  {
    name: 'Gated forager',
    text: 'Steering switched by energy (E, 0..1 full), with gates: coloured things AND NOT energy pull it to flowers by (1 − E), scum AND energy to scum by E, so a hungry midge heads for flowers and a full one for scum, blending in between. Eat = 3.5 × coloured things × (1 − E) − 1.5: on right beside a flower while hungry (E 0: closeness above 0.43; E 0.5: above 0.86; above 0.57: never). Lay = 2 × scum × E − 1: on over scum once full enough. Eating raises E, which turns it to scum; laying spends E, which turns it back to flowers. Noise: direction makes it roam when nothing is in view. Not tuned or tested.',
    body: { vision: 40 },
    links: [
      ['colour', 'steer', 'tanh', { where: 2.5 }, ['andnot', 'energy']],
      ['scum', 'steer', 'tanh', { where: 0.8 }, ['and', 'energy']],
      ['colour', 'eat', 'linear', { where: 3.5 }, ['andnot', 'energy']],
      ['bias', 'eat', 'linear', { value: -1.5 }],
      ['scum', 'lay', 'linear', { where: 2 }, ['and', 'energy']],
      ['bias', 'lay', 'linear', { value: -1 }],
      ['self', 'steer', 'tanh', { velocity: 0.4 }],
      ['wander', 'steer', 'tanh', { where: 0.4 }],
    ],
  },
  {
    name: 'Sun climber',
    text: 'A scalar input (brightness) steers only up or down, on top of its flight height: in sun it holds higher, under cloud lower. Height matters, since the wind is stronger higher up and rain falls through it.',
    links: [
      ['brightness', 'steer', 'linear', { value: 0.5 }],
      ['noise', 'steer', 'linear', { value: 0.6 }],
      ['self', 'steer', 'tanh', { velocity: 0.3 }],
    ],
  },
]

/**
 * A toy NEAT-style brain with memory, run here (not in the sim): a hunger
 * latch. Energy (E) feeds a latch with weight −2 and bias 1.4, so its input
 * is 1.4 − 2E: at or above 1 (E ≤ 0.2) it sets, at or below 0 (E ≥ 0.7) it
 * resets. A mult node gates "sees food" by the latch into eat. Energy burns
 * 0.08/s, and while eating near food it fills at 0.3/s.
 */
function hungerLatchRun() {
  const out = []
  let E = 0.9
  let latch = 0
  for (let t = 0; t <= 30 + 1e-9; t += 0.1) {
    const food = t % 12 < 8 ? 1 : 0 // food in sight 8 s of every 12
    const xl = -2 * E + 1.4
    latch = xl >= 1 ? 1 : xl <= 0 ? 0 : latch
    const eat = latch * food
    E = Math.min(1, Math.max(0, E + (eat > 0 ? 0.3 : 0) * 0.1 - 0.08 * 0.1))
    out.push({ t, E, latch, food, eat })
  }
  return out
}

/** A latch's picture: a test source (0 → 1 → 0 → 0.7 → 0) and its state against time, its on and off thresholds dashed. */
function LatchCard({ on, off }) {
  const TW = 286
  const TH = 54
  const N = 200
  const src = (k) => {
    const u = k / N
    if (u < 0.35) return u / 0.35
    if (u < 0.7) return 1 - (u - 0.35) / 0.35
    if (u < 0.85) return ((u - 0.7) / 0.15) * 0.7
    return 0.7 * (1 - (u - 0.85) / 0.15)
  }
  let st = 0
  const pts = Array.from({ length: N + 1 }, (_, k) => {
    const m = src(k)
    st = on >= off ? (m >= on ? 1 : m <= off ? 0 : st) : m <= on ? 1 : m >= off ? 0 : st
    return [k, m, st]
  })
  const tx = (k) => 4 + (k / N) * (TW - 8)
  const ty = (v) => TH - 4 - v * (TH - 10)
  const line = (j) => pts.map((p, k) => `${k ? 'L' : 'M'}${tx(p[0]).toFixed(1)},${ty(p[j]).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${TW} ${TH}`} className="w-full" role="img" aria-label="A latch's state against a rising and falling source">
      <line x1={tx(0)} y1={ty(on)} x2={tx(N)} y2={ty(on)} stroke="#4ade80" strokeWidth={0.5} strokeDasharray="2 2" />
      <line x1={tx(0)} y1={ty(off)} x2={tx(N)} y2={ty(off)} stroke="#f87171" strokeWidth={0.5} strokeDasharray="2 2" />
      <path d={line(1)} fill="none" stroke="#64748b" strokeWidth={0.8} strokeDasharray="2 1.2" />
      <path d={line(2)} fill="none" stroke="#fbbf24" strokeWidth={1.2} />
    </svg>
  )
}

/** A small node graph: nodes { id, label, x, y, kind }, edges [from, to, weight]. */
function NodeGraph({ nodes, edges, height = 70 }) {
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const fill = { input: '#1e3a5f', hidden: '#78350f', output: '#14532d' }
  return (
    <svg viewBox={`0 0 286 ${height}`} className="w-full" style={{ fontSize: 7 }} role="img" aria-label="A brain drawn as nodes and synapses">
      {edges.map(([a, b, w], k) => {
        const p = at[a]
        const q = at[b]
        const mx = (p.x + q.x) / 2
        const my = (p.y + q.y) / 2
        return (
          <g key={k}>
            <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={w >= 0 ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.7)'} strokeWidth={0.6 + Math.min(2, Math.abs(w)) * 0.5} />
            <text x={mx} y={my - 2} textAnchor="middle" fill="#cbd5e1" stroke="#0f172a" strokeWidth={1.6} paintOrder="stroke" style={{ fontSize: 6 }}>
              {w > 0 ? '+' : ''}
              {w}
            </text>
          </g>
        )
      })}
      {nodes.map((n) => (
        <g key={n.id}>
          <rect x={n.x - 30} y={n.y - 7} width={60} height={14} rx={7} fill={fill[n.kind]} stroke="#475569" strokeWidth={0.5} />
          <text x={n.x} y={n.y + 2.5} textAnchor="middle" fill="#e2e8f0">
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

function Trace({ run }) {
  const TW = 286
  const TH = 64
  const tx = (t) => 4 + (t / 30) * (TW - 8)
  const ty = (v) => TH - 4 - v * (TH - 10)
  const line = (key) => run.map((r, k) => `${k ? 'L' : 'M'}${tx(r.t).toFixed(1)},${ty(r[key]).toFixed(1)}`).join('')
  const series = [
    ['food', '#64748b', 'food in sight'],
    ['E', '#38bdf8', 'energy'],
    ['latch', '#fbbf24', 'latch (hungry)'],
    ['eat', '#4ade80', 'eat'],
  ]
  return (
    <>
      <svg viewBox={`0 0 ${TW} ${TH}`} className="w-full" role="img" aria-label="Energy, the latch, food in sight and eating over 30 seconds">
        <line x1={tx(0)} y1={ty(0.2)} x2={tx(30)} y2={ty(0.2)} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 2" />
        <line x1={tx(0)} y1={ty(0.7)} x2={tx(30)} y2={ty(0.7)} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 2" />
        {series.map(([key, colour]) => (
          <path key={key} d={line(key)} fill="none" stroke={colour} strokeWidth={key === 'food' ? 0.8 : 1.2} strokeDasharray={key === 'food' ? '2 1.5' : undefined} />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 text-[10px]">
        {series.map(([key, colour, label]) => (
          <span key={key} style={{ color: colour }}>
            ━ {label}
          </span>
        ))}
      </div>
    </>
  )
}

/** A random heading every 1 / rate s, turned to the shorter way with smoothstep: the same as the shader's noise: direction (species/midges.js). */
function wanderRun(rate = 0.5, seconds = 30, dt = 1 / 30, speed = 40) {
  const targets = Array.from({ length: Math.ceil(seconds * rate) + 2 }, () => Math.random() * Math.PI * 2)
  const pts = []
  let x = 0
  let y = 0
  for (let t = 0; t <= seconds; t += dt) {
    const u = t * rate
    const i = Math.floor(u)
    const f = u - i
    let d = targets[i + 1] - targets[i]
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI))
    const a = targets[i] + d * f * f * (3 - 2 * f)
    x += Math.cos(a) * speed * dt
    y += Math.sin(a) * speed * dt
    pts.push({ t, a, x, y })
  }
  return pts
}

/** Noise: a fresh uniform draw each step (60 steps over 1 s drawn), and noise: direction, its heading over time and the path it alone would fly. */
function NoisePictures({ input }) {
  const [seed, setSeed] = useState(0)
  const noise = useMemo(() => Array.from({ length: 61 }, () => Math.random() * 2 - 1), [seed])
  const wander = useMemo(() => wanderRun(), [seed])
  const TW = 300
  const TH = 70
  if (input.key === 'noise') {
    const tx = (k) => 4 + (k / 60) * (TW - 8)
    const ty = (v) => TH / 2 - v * (TH / 2 - 4)
    return (
      <div>
        <svg viewBox={`0 0 ${TW} ${TH}`} className="w-full" role="img" aria-label="Noise over one second: a new random value every step">
          <line x1={0} y1={ty(0)} x2={TW} y2={ty(0)} stroke="#334155" strokeWidth={0.5} />
          <path d={noise.map((v, k) => `${k ? 'L' : 'M'}${tx(k).toFixed(1)},${ty(v).toFixed(1)}`).join('')} fill="none" stroke="#38bdf8" strokeWidth={1} />
        </svg>
        <p className="text-[11px] text-slate-500">One second at 60 steps: every step a new value, unrelated to the last. <button type="button" className="underline hover:text-slate-300" onClick={() => setSeed((k) => k + 1)}>New draw</button></p>
      </div>
    )
  }
  const xs = wander.map((p) => p.x)
  const ys = wander.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const span = Math.max(x1 - x0, y1 - y0, 1)
  const PS = 120
  const px = (v) => 6 + ((v - x0) / span) * (PS - 12)
  const py = (v) => 6 + ((v - y0) / span) * (PS - 12)
  const tx = (t) => 4 + (t / 30) * (TW - 8)
  const ty = (a) => TH - 4 - ((((a / (2 * Math.PI)) % 1) + 1) % 1) * (TH - 8)
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
        <svg viewBox={`0 0 ${TW} ${TH}`} className="w-full" role="img" aria-label="Its heading over 30 seconds">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={0} y1={TH - 4 - f * (TH - 8)} x2={TW} y2={TH - 4 - f * (TH - 8)} stroke="#1e293b" strokeWidth={0.5} />
          ))}
          {wander.map((p, k) => (k % 2 ? null : <circle key={k} cx={tx(p.t)} cy={ty(p.a)} r={0.9} fill="#a78bfa" />))}
        </svg>
        <svg viewBox={`0 0 ${PS} ${PS}`} width={PS} height={PS} className="rounded bg-slate-950/60" role="img" aria-label="The path a midge steered only by it would fly">
          <path d={wander.map((p, k) => `${k ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join('')} fill="none" stroke="#a78bfa" strokeWidth={1} />
          <circle cx={px(0)} cy={py(0)} r={2.5} fill="#f8fafc" />
        </svg>
      </div>
      <p className="text-[11px] text-slate-500">Left: its heading (0° to 360°) over 30 s at a wander rate of 0.5 /s, a new target every 2 s, turned to smoothly. Right: the path a midge steered by it alone would fly (white: the start). <button type="button" className="underline hover:text-slate-300" onClick={() => setSeed((k) => k + 1)}>New draw</button></p>
    </div>
  )
}

const RANK_STYLE = ['bg-amber-500/15 text-amber-300', 'bg-violet-500/15 text-violet-300']

/** What a link from an input gives steering and eat or lay, by its rank unless the input says otherwise. */
function inputUse(input, doc) {
  const steer = doc.steer ?? (input.rank ? 'A push towards it (positive weight) or away (negative), stronger the more it sees and the nearer.' : 'Up or down only: a scalar has no direction (weight × value × 100 px/s²).')
  const drive = doc.drive ?? (input.rank ? 'Its strength (how many, how near) × the weight.' : 'Its value × the weight.')
  return { steer, drive }
}

function InputCard({ input }) {
  const doc = INPUT_DOCS[input.key] ?? {}
  const use = inputUse(input, doc)
  const row = (label, text) => (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-300">{text}</dd>
    </div>
  )
  return (
    <article className={`rounded-lg border border-slate-700/60 bg-slate-800/40 p-3 ${input.key === 'noise' || input.key === 'wander' || input.latch ? 'md:col-span-2' : ''}`}>
      <header className="mb-1.5 flex items-center gap-2">
        <h4 className={`text-sm font-medium ${input.none ? 'text-slate-500' : 'text-slate-100'}`}>{input.label}</h4>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${RANK_STYLE[input.rank]}`}>{RANK[input.rank]}</span>
        {input.elements.length > 1 && <span className="text-[10px] text-slate-500">elements: {input.elements.map((e) => e.key).join(', ')}</span>}
      </header>
      <p className="mb-2 text-xs text-slate-300">{doc.about}</p>
      <dl className="space-y-1 text-xs">
        {row('Values', doc.range)}
        {row('Over time', doc.updates)}
        {row('→ steering', use.steer)}
        {row('→ eat, lay', use.drive)}
      </dl>
      {(input.key === 'noise' || input.key === 'wander') && (
        <div className="mt-2">
          <NoisePictures input={input} />
        </div>
      )}
      {input.latch && (
        <div className="mt-2">
          <LatchCard on={0.9} off={0.5} />
          <p className="text-[11px] text-slate-500">A rising latch (on at 0.9, off at 0.5) against a source that rises to 1, falls, rises to 0.7 and falls (dashed): it switches on at 0.9, stays on down to 0.5, and the second rise (only to 0.7) does not switch it back on.</p>
        </div>
      )}
    </article>
  )
}

function OutputCard({ output }) {
  const doc = OUTPUT_DOCS[output.key] ?? {}
  return (
    <article className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
      <header className="mb-1.5 flex items-center gap-2">
        <h4 className="text-sm font-medium text-slate-100">{output.label}</h4>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${RANK_STYLE[output.rank]}`}>{RANK[output.rank]}</span>
      </header>
      <p className="mb-1.5 text-xs text-slate-300">{doc.about}</p>
      <p className="text-xs text-slate-400">{doc.how}</p>
    </article>
  )
}

/** How a link computes, as a row of steps. */
function LinkFlow() {
  const step = (title, text, tone) => (
    <div className={`min-w-0 flex-1 rounded-lg border p-2.5 ${tone}`}>
      <div className="text-xs font-medium text-slate-100">{title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{text}</div>
    </div>
  )
  const arrow = <div className="hidden shrink-0 self-center text-slate-500 md:block">→</div>
  return (
    <div className="flex flex-col gap-2 md:flex-row">
      {step('Input', 'What it senses: a vector (a direction and a strength) or a scalar (one number).', 'border-sky-700/50 bg-sky-950/30')}
      {arrow}
      {step('× weights', 'A weight gene per element of the input (−3..3). The link sums them.', 'border-slate-700 bg-slate-800/40')}
      {arrow}
      {step('Activation', 'The sum through one function (a gene): linear, step, tanh, …', 'border-slate-700 bg-slate-800/40')}
      {arrow}
      {step('× gate', 'Optional: scaled, switched or reversed by another input (gate, gate input and threshold genes).', 'border-amber-700/50 bg-amber-950/20')}
      {arrow}
      {step('Output', 'Steering: every link’s push adds up to a force. Eat, lay: the links add up, pass a neuron, on above 0; the larger wins.', 'border-green-700/50 bg-green-950/20')}
    </div>
  )
}

const GUIDE_SECTIONS = [
  ['overview', 'How it works'],
  ['inputs', 'Inputs'],
  ['outputs', 'Outputs'],
  ['activations', 'Activations'],
  ['gates', 'Logic gates'],
  ['neurons', 'Output neurons'],
  ['examples', 'Example brains'],
  ['facts', 'Settings and rules'],
  ['ideas', 'Ideas not in the sim'],
]

function GuideSection({ id, title, intro, children }) {
  return (
    <section id={`brain-${id}`} className="scroll-mt-4 space-y-3 border-b border-slate-800 pb-8 pt-2 last:border-0">
      <h3 className="text-base font-semibold text-slate-100">{title}</h3>
      {intro && <p className="max-w-3xl text-sm leading-relaxed text-slate-400">{intro}</p>}
      {children}
    </section>
  )
}

/** The brain guide: everything about how a midge's brain works, in one wide page. `actions.restart(profile)` spawns a flock from an example; `onClose` after it. */
export function BrainGuide({ params, setParam, actions, onSpawned }) {
  const [x, setX] = useState(0.5)
  const [gm, setGm] = useState(0.3)
  const [gt, setGt] = useState(0.5)
  const examples = useMemo(() => [CYCLER, ...EXAMPLES, TEST_01].map((ex) => ({ ...ex, genes: handmadeGenes(ex) })), [])
  const latchRun = useMemo(hungerLatchRun, [])
  const inSim = FUNCTIONS.filter((f) => f.inSim)
  const proposed = FUNCTIONS.filter((f) => !f.inSim)
  return (
    <>
      <GuideSection
        id="overview"
        title="How a midge brain works"
        intro="Every midge has its own brain, written in its genes. It has no hidden layers: each input links straight to each output it is wired to. Every step the links work out where to fly (steering) and whether to come down to eat or to lay. Nothing else steers it: what it does is its wiring acting on what it senses."
      >
        <LinkFlow />
        <div className="grid gap-3 text-xs text-slate-400 md:grid-cols-3">
          <div className="rounded-lg bg-slate-800/40 p-3">
            <div className="mb-1 font-medium text-slate-200">What evolves</div>
            Which links exist (made and broken in hatchlings), each link’s weights, activation and gate (its type, its input, its threshold), its latch (source, on, off), its wander rate, its eat and lay neurons, and its body (vision, speed, flight height, clutch, and the colour it looks for). Each hatchling is a mutated copy of its parent.
          </div>
          <div className="rounded-lg bg-slate-800/40 p-3">
            <div className="mb-1 font-medium text-slate-200">What it costs</div>
            Every link burns energy every second whether it acts or not, each further link a little more than the last. Gates and latches are free. So a brain only keeps links that pay for themselves.
          </div>
          <div className="rounded-lg bg-slate-800/40 p-3">
            <div className="mb-1 font-medium text-slate-200">What selects</div>
            Only eggs laid on scum hatch, and a midge must eat (on an open flower) to have the energy to lay. Past its lifespan it slows and burns more until it starves. The brains that get the most hatchlings spread.
          </div>
        </div>
      </GuideSection>

      <GuideSection id="inputs" title="Inputs" intro="What a midge senses. Vector inputs have a direction and a strength; scalar inputs are one number. It sees within its vision gene in 3D, and less the lower it flies (a tenth of its vision at the water). Sensed inputs refresh every tick (Senses every N steps, in the Midges tab); the rest every step.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {MIDGE_INPUTS.map((input) => (
            <InputCard key={input.key} input={input} />
          ))}
        </div>
      </GuideSection>

      <GuideSection id="outputs" title="Outputs" intro="What a midge does. Steering is always acting while it flies; eat and lay are on or off, and at most one is on (the larger).">
        <div className="grid gap-3 md:grid-cols-3">
          {MIDGE_OUTPUTS.map((o) => (
            <OutputCard key={o.key} output={o} />
          ))}
        </div>
      </GuideSection>

      <GuideSection id="activations" title="Activation functions" intro="Each link passes the sum of its weighted input (x) through one of these, its activation gene. To eat and lay the result is that link’s share of the drive; to steering it acts on the push’s size (in units of 100 px/s²), keeping its direction. Move x to see each one’s output.">
        <div className="max-w-md">
          <Slider label="x" value={x} min={-4} max={4} step={0.05} onChange={setX} />
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {inSim.map((fn) => (
            <FnCard key={fn.key} fn={fn} x={x} />
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="gates"
        title="Logic gates"
        intro="A link may have a gate: after its activation, its result is multiplied by g, worked out from another input (its gate input, a gene) and a threshold t (a gene). m is the gate input’s value (a vector input’s strength), clamped to 0..1. So one input can scale, switch or reverse another: scum IF latch pulls to scum only while the latch is on; colour FLIP latch pulls to flowers while it is off and pushes away while it is on. Gates appear in amber on the wiring diagram, with a dotted line from their gate input. A fresh flock gets gates by the starting-gates chance, and mutation adds, changes and removes them."
      >
        <div className="grid max-w-2xl gap-x-6 md:grid-cols-2">
          <Slider label="m (gate input)" value={gm} min={-0.25} max={1.25} step={0.01} onChange={setGm} />
          <Slider label="t (threshold)" value={gt} min={0} max={1} step={0.01} onChange={setGt} />
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          {GATES.map((g, k) => (
            <GateCard key={g.key} k={k} m={gm} t={gt} />
          ))}
        </div>
      </GuideSection>

      <GuideSection id="neurons" title="Output neurons (eat and lay)" intro="The sum of the links into eat (and into lay) passes through a neuron before the on/off test; its type and rate are genes. Three remember from step to step, so they are drawn against time over 10 s: dashed, a test input (a rise, a hold, a dip, a pulse); solid, the neuron’s output.">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {NEURONS.map((fn) => (
            <FnCard key={fn.key} fn={fn} x={x} />
          ))}
        </div>
      </GuideSection>

      <GuideSection id="examples" title="Example brains" intro="Hand-made wirings, to show what the wiring can express; not tuned for survival. Spawning one replaces the flock with mutated copies (exact copies with the profile locked in the Midges tab). The eat–lay cycler is a template to evolve from: it uses the latch, gates and noise: direction together.">
        <div className="grid gap-3 lg:grid-cols-2">
          {examples.map((ex) => (
            <article key={ex.name} className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
              <header className="mb-1 flex items-baseline justify-between">
                <h4 className="text-sm font-medium text-slate-100">{ex.name}</h4>
                <span className="text-[11px] text-slate-500">
                  {ex.links.length} link{ex.links.length === 1 ? '' : 's'}
                </span>
              </header>
              <p className="text-xs leading-relaxed text-slate-400">{ex.text}</p>
              <WiringDiagram genes={ex.genes} link={(b) => (ex.links.some(([i, o]) => linkBit(MIDGE_INPUTS.findIndex((n) => n.key === i), MIDGE_OUTPUTS.findIndex((n) => n.key === o)) === b) ? 1 : 0)} />
              <button
                type="button"
                className={`${button} mt-1 w-full`}
                onClick={() => {
                  setParam('showInsects', true)
                  actions.restart({ name: ex.name, genes: ex.genes })
                  onSpawned?.()
                }}
              >
                Spawn a flock of {ex.name.toLowerCase()}s
              </button>
            </article>
          ))}
        </div>
      </GuideSection>

      <GuideSection id="facts" title="Settings, constants and rules" intro="Everything else the brain computes with, so nothing acts unseen. The same list is under each wiring diagram, with that midge’s (or the population’s) own brain genes.">
        <div className="max-w-3xl">
          <BrainFacts params={params} title="Settings, constants and rules" open />
        </div>
      </GuideSection>

      <GuideSection id="ideas" title="Ideas not in the sim" intro="Functions and nodes from a fuller NEAT-style design (hidden nodes, each with its own activation and memory). Drawn here for comparison; a midge cannot have them.">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {proposed.map((fn) => (
            <FnCard key={fn.key} fn={fn} x={x} />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            <h4 className="text-sm text-slate-200">A hunger latch with a mult node</h4>
            <p className="text-xs text-slate-400">The latch’s input is 1.4 − 2 × energy: on when energy falls to 0.2, off once it is back to 0.7. A mult node lets “food in sight” through to eat only while the latch is on. (The sim can now do this with its latch input and an IF gate.)</p>
            <NodeGraph
              height={74}
              nodes={[
                { id: 'E', label: 'energy', x: 34, y: 16, kind: 'input' },
                { id: 'F', label: 'food in sight', x: 34, y: 58, kind: 'input' },
                { id: 'L', label: 'latch (b 1.4)', x: 140, y: 16, kind: 'hidden' },
                { id: 'M', label: 'mult (b 1)', x: 140, y: 58, kind: 'hidden' },
                { id: 'O', label: 'eat', x: 250, y: 37, kind: 'output' },
              ]}
              edges={[
                ['E', 'L', -2],
                ['L', 'M', 1],
                ['F', 'M', 1],
                ['M', 'O', 1],
              ]}
            />
            <Trace run={latchRun} />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm text-slate-200">Habituation</h4>
            <p className="text-xs text-slate-400">An inhibitory node between “midges seen” and steering: it answers a change in the crowd (a midge arriving) and fades back to 0 while the crowd stays the same, so a midge reacts to newcomers but not to the swarm it is already in.</p>
            <NodeGraph
              height={34}
              nodes={[
                { id: 'N', label: 'midges (where)', x: 34, y: 17, kind: 'input' },
                { id: 'I', label: 'inhibitory (b 1)', x: 140, y: 17, kind: 'hidden' },
                { id: 'S', label: 'steering', x: 250, y: 17, kind: 'output' },
              ]}
              edges={[
                ['N', 'I', 1],
                ['I', 'S', -0.8],
              ]}
            />
          </div>
        </div>
      </GuideSection>
    </>
  )
}

/** The brain guide in a wide modal over the pond, with a menu of its sections. Esc or a click outside closes it. */
export function BrainModal({ open, onClose, ...props }) {
  const body = useRef(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  const go = (id) => body.current?.querySelector(`#brain-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Midge brain guide" className="flex h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-700/60 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Midge brain guide</h2>
            <p className="text-xs text-slate-500">How a midge senses, decides and evolves</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800" aria-label="Close the brain guide">
            Close ✕
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav className="hidden w-48 shrink-0 space-y-0.5 overflow-y-auto border-r border-slate-800 p-3 md:block">
            {GUIDE_SECTIONS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => go(id)} className="block w-full rounded px-2 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-100">
                {label}
              </button>
            ))}
          </nav>
          <div ref={body} className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
            <BrainGuide {...props} onSpawned={onClose} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
