import { ACTIVATIONS, activationKey, BRAIN_CONSTANTS, gateInputKey, gateKey, GATES, gateThresholdKey, LATCHES, latchKeys, BRAIN_PARAMS, BRAIN_RULES, linkBit, MIDGE_GENES, MIDGE_INPUTS, MIDGE_OUTPUTS, NODE_TYPES, nodeKey, RANK, rateKey, seekColour, weightKey } from '../species/midges.js'
import { Hint, LogSlider, RangeModes, Section, Segmented, Slider, StatGrid, TickRate, Toggle } from './controls.jsx'
import { GeneTable, PopulationChart, Profiles, button, dangerButton } from './evolution.jsx'
import { ProfileEditor } from './ProfileEditor.jsx'

/** The genes shown in tables: its body's (the links, their weights and activations, and its neurons are drawn as a diagram instead; fixed genes are listed with the brain's facts). */
export const GENES = MIDGE_GENES.filter((g) => !g.wires && !g.weight && !g.activation && !g.gate && !g.node && !g.fixed && !g.seek && !g.brainGene)

/** A rank's colour in the diagrams: vectors violet, scalars amber. */
const RANK_FILL = ['#fbbf24', '#c4b5fd']
/** A colour (RGB 0..1) as CSS. */
export const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`

/** A colour gene as a swatch and its RGB. */
export function ColourGene({ genes }) {
  const c = seekColour(genes)
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-slate-600" style={{ background: css(c) }} />
      <span className="font-mono tabular-nums">{c.map((v) => v.toFixed(2)).join(' ')}</span>
    </span>
  )
}

/** An output's neuron (NODE_TYPES) and its rate, from its genes (null for steering, which has none). */
export function neuronOf(genes, out) {
  if (!out.neuron) return null
  const type = NODE_TYPES[Math.min(NODE_TYPES.length - 1, Math.max(0, Math.round(genes[nodeKey(out.key)] ?? 0)))]
  return { type, rate: Math.min(10, Math.max(0.1, genes[rateKey(out.key)] ?? 1)) }
}

/** Diagram rows (px), and how big a force (px/s²) or eat / lay drive draws a line at full strength. */
const ROW = 13
const FULL_FORCE = 250
const FULL_DRIVE = 1

/** A line's colour for a signed value (−1..1 at full): green positive, red negative, faint near 0. */
function flow(v) {
  const a = Math.min(1, Math.abs(v))
  if (a < 0.02) return { stroke: 'rgba(148,163,184,0.25)', width: 0.75 }
  const c = v > 0 ? '74,222,128' : '248,113,113'
  return { stroke: `rgba(${c},${0.25 + 0.75 * a})`, width: 0.75 + 1.25 * a }
}

/**
 * What acts on a midge's flight besides its wiring: the world and its body,
 * the same for every midge (species/midges.js act). `force`: read back; or
 * `signal`: (signals) => [0..1 how hard it acts now, text].
 */
const FIXED = [
  { key: 'drag', label: 'air drag', force: 'drag', hint: 'Air drag slows it: with no steering it drifts to a halt.' },
  { key: 'hold', label: 'height hold', signal: (s) => [Math.min(1, Math.abs(s.hold ?? 0) / FULL_FORCE), s.hold ? `${s.hold >= 0 ? '↑' : '↓'}${Math.abs(s.hold).toFixed(0)} → ${(s.holdAt ?? 0).toFixed(0)} px` : '–'], hint: 'Flying with eat and lay off, a damped pull holds it near its flight height gene (HEIGHT_PULL per px off it, HEIGHT_DAMP braking its climb or sink), on top of its steering; at the water it is its lift to take off. Shown: its push now (px/s², ↑ up) → the height it holds.' },
  { key: 'descend', label: 'coming down', force: 'descend', hint: 'With eat or lay on, it glides down: its steering acts sideways at GLIDE_STEER, it brakes, and its sink eases to 20 px/s; it stays down while that output is on.' },
  { key: 'cap', label: 'speed cap', signal: (s) => [s.capped, s.maxS > 0 ? `${s.maxS.toFixed(0)}${s.capped > 0.5 ? ' hit' : ''}` : '–'], hint: 'It never flies faster than its max speed gene (slower past its lifespan): any faster, it is held back to it ("hit" while it is).' },
  { key: 'walls', label: 'edge, ground, ceiling', signal: (s) => [s.blocked, s.blocked > 0.5 ? 'hit' : '–'], hint: 'The map\'s edge, the water or ground and a ceiling 40 px up stop it: its way out is lost ("hit" while one does).' },
  { key: 'drift', label: 'wind drift', force: 'drift', unit: 'px/s', full: 50, hint: 'The wind carries it along on top of its own flight (more the higher it flies, less in the lee of plants and trunks); not in its steering total.' },
]

/** A fixed part's line colour: cyan, brighter the stronger (0..1). */
function fixedFlow(v) {
  const a = Math.min(1, Math.abs(v))
  return a < 0.02 ? { stroke: 'rgba(148,163,184,0.25)', width: 0.75 } : { stroke: `rgba(103,232,249,${0.3 + 0.7 * a})`, width: 0.75 + 1.25 * a }
}

/** An input as text: how many things of it it sees (coloured things: how much, each by how near its colour is); a number as its value (energy, brightness in %, age in lifespans). */
function inputText(input, v) {
  if (input.none) return '–'
  if (input.key === 'bias') return '1'
  if (input.key === 'wander') return 'roaming'
  if (input.latch) return v > 0.5 ? 'on' : 'off'
  if (input.key === 'energy' || input.key === 'brightness') return `${Math.round(v * 100)}%`
  if (input.key === 'age' || input.key === 'noise') return v.toFixed(2)
  if (input.key === 'self') return `${v.toFixed(0)} px/s`
  if (input.key === 'colour') return `${v.toFixed(2)} seen`
  return `${v.toFixed(0)} seen`
}

/** A link's activation function (ACTIVATIONS), from its gene. */
export const activationOf = (genes, i, o) => ACTIVATIONS[Math.min(ACTIVATIONS.length - 1, Math.max(0, Math.round(genes[activationKey(i, o)] ?? 0)))]

/** A link's gate (GATES) and its gate input (MIDGE_INPUTS), from its genes: null with no gate. */
export function gateOf(genes, i, o) {
  const type = Math.min(GATES.length - 1, Math.max(0, Math.round(genes[gateKey(i, o)] ?? 0)))
  if (!type) return null
  const by = Math.min(MIDGE_INPUTS.length - 1, Math.max(0, Math.round(genes[gateInputKey(i, o)] ?? 0)))
  return { gate: GATES[type], index: type, by, input: MIDGE_INPUTS[by], t: genes[gateThresholdKey(i, o)] ?? 0.5 }
}
/** A gate in words: "UNLESS latch > 0.50" ('' with none). */
export const gateText = (g) => (g ? `${g.gate.label} ${g.input.label}${g.gate.threshold ? ` > ${g.t.toFixed(2)}` : ''}` : '')
/** A gate as the diagram labels it: "if ¬latch>.5". */
export const gateShort = (g) => (g ? `${g.gate.symbol}${g.input.label.split(/[ :]/)[0]}${g.gate.threshold ? `>${+g.t.toFixed(2)}` : ''}` : '')
/** A latch's genes: its source input, on and off thresholds, and which way it goes. */
export function latchOf(genes, l) {
  const k = latchKeys(l)
  const src = MIDGE_INPUTS[Math.min(MIDGE_INPUTS.length - 1, Math.max(0, Math.round(genes[k.src] ?? 0)))]
  const on = genes[k.on] ?? 0.8
  const off = genes[k.off] ?? 0.2
  return { src, on, off, rises: on >= off }
}
/** A latch's rule, short (the diagram): "energy ↑0.8 ↓0.2" (on at, off at; ↑ rising). */
export function latchShort(genes, l) {
  const { src, on, off, rises } = latchOf(genes, l)
  return `${src.label.split(/[ :]/)[0]} ${rises ? '↑' : '↓'}${+on.toFixed(2)} ${rises ? '↓' : '↑'}${+off.toFixed(2)}`
}
/** A latch's rule in words: "energy ≥ 0.80 on, ≤ 0.20 off". */
export function latchText(genes, l) {
  const { src, on, off, rises } = latchOf(genes, l)
  return rises ? `${src.label} ≥ ${on.toFixed(2)} on, ≤ ${off.toFixed(2)} off` : `${src.label} ≤ ${on.toFixed(2)} on, ≥ ${off.toFixed(2)} off`
}

/** The weights on a link: [element name, weight] per element of its input. */
export function linkWeights(genes, i, o) {
  const input = MIDGE_INPUTS[i]
  return input.elements.map((el) => [input.number ? 'weight' : el.key, genes[weightKey(i, el.key, o)] ?? 0])
}

/**
 * A midge's wiring (species/midges.js): its inputs, linked straight to its
 * outputs (steering, eat, lay), each link with a weight per element of its
 * input; below, dashed, what acts on its flight besides (FIXED). `link(bit)`
 * is 0..1: one midge's links (0 or 1), or the share of the population that
 * has each.
 *
 * Live (`senses`: the selected midge's debug read), each line carries what
 * that link adds to its output now, green positive, red negative, brighter
 * the stronger (steering, its size: green). Without, each line is as opaque
 * as the share that has it. Hover a line for its weights.
 */
export function WiringDiagram({ genes, link, senses }) {
  const sig = senses?.signals
  const forces = senses?.forces
  const NI = MIDGE_INPUTS.length
  const rows = NI + 1 + FIXED.length
  const H = rows * ROW + 6
  const iy = (i) => 9 + i * ROW
  const fy = (f) => iy(NI + 1 + f)
  const oy = (o) => 9 + ((o + 0.5) * (rows - 1) * ROW) / MIDGE_OUTPUTS.length
  const X = { in: 118, out: 228 }
  const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2))
  // What a link adds to its output now, scaled to −1..1 at full.
  const linkValue = (input, o) => (o.key === 'steer' ? Math.min(1, (sig[`steer_${input.key}`] ?? 0) / FULL_FORCE) : (sig[`${o.key}_${input.key}`] ?? 0) / FULL_DRIVE)
  const sgn = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
  const outText = (o) => {
    if (!sig) return ''
    if (o.key === 'steer') return `${(sig.steer ?? 0).toFixed(0)} px/s²`
    const v = sig[o.key] ?? 0
    const n = neuronOf(genes, o)
    return `${n && n.type.key !== 'plain' ? `${sgn(sig[`${o.key}Sum`] ?? 0)} → ` : ''}${sgn(v)} ${outOn(o) ? 'on' : 'off'}`
  }
  // An output's neuron, under its name: its type (and rate where it has one), and live its memory.
  const neuronText = (o) => {
    const n = neuronOf(genes, o)
    if (!n) return ''
    const rate = n.type.key === 'smooth' || n.type.key === 'change' ? ` ${n.rate.toFixed(1)}/s` : ''
    const mem = sig && n.type.key !== 'plain' ? ` · m ${(sig[`${o.key}Mem`] ?? 0).toFixed(2)}` : ''
    return `neuron: ${n.type.label}${rate}${mem}`
  }
  const outOn = (o) => sig && o.key !== 'steer' && (sig[o.key] ?? 0) > 0 && (o.key === 'eat' ? sig.eat >= (sig.lay ?? 0) : sig.lay > (sig.eat ?? 0))
  const lines = []
  MIDGE_INPUTS.forEach((input, i) => {
    MIDGE_OUTPUTS.forEach((o, k) => {
      const share = link(linkBit(i, k))
      if (share <= 0) return
      const st = sig ? flow(linkValue(input, o)) : { stroke: `rgba(190,242,100,${0.1 + 0.8 * share})`, width: 0.5 + share }
      const fn = activationOf(genes, i, k)
      const gt = gateOf(genes, i, k)
      const title = `${input.label} → ${o.key}: weights ${linkWeights(genes, i, k).map(([n, w]) => `${n} ${fmt(w)}`).join(', ')}; activation ${fn.label} (${fn.hint}); ${gt ? `gate ${gateText(gt)} (${gt.gate.formula}, m: ${gt.input.label}${gt.input.vector ? '’s strength' : ''}, clamped to 0..1)` : 'no gate'}${sig ? '' : ` (mean weights, most common activation and gate; ${Math.round(share * 100)}% have it)`}`
      // The activation sits on the link, along it by output so links to the same output don't stack theirs.
      const t = 0.42 + k * 0.08
      const mx = X.in + 2 + (X.out - X.in - 4) * t
      const my = iy(i) + (oy(k) - iy(i)) * t
      lines.push(
        <g key={`l${i}-${k}`}>
          <line x1={X.in + 2} y1={iy(i)} x2={X.out - 2} y2={oy(k)} stroke={st.stroke} strokeWidth={st.width} />
          {gt && <line x1={X.in + 2} y1={iy(gt.by)} x2={mx} y2={my} stroke="rgba(251,191,36,0.55)" strokeWidth={0.5} strokeDasharray="1 1" />}
          <text x={mx} y={my + 1.8} textAnchor="middle" fill="#cbd5e1" stroke="#0f172a" strokeWidth={1.6} paintOrder="stroke" style={{ fontSize: 5 }}>
            {fn.short}
            {gt && <tspan fill="#fbbf24"> {gateShort(gt)}</tspan>}
          </text>
          <line x1={X.in + 2} y1={iy(i)} x2={X.out - 2} y2={oy(k)} stroke="transparent" strokeWidth={6} style={{ pointerEvents: 'stroke', cursor: 'help' }}>
            <title>{title}</title>
          </line>
        </g>,
      )
    })
  })
  const fixedNow = (f) => {
    if (!sig) return [0, '']
    if (f.signal) return f.signal(sig)
    const v = forces?.[f.force] ?? 0
    return [v / (f.full ?? FULL_FORCE), v >= 0.5 ? v.toFixed(0) : '–']
  }
  FIXED.forEach((f, j) => {
    const st = sig ? fixedFlow(fixedNow(f)[0]) : { stroke: 'rgba(103,232,249,0.35)', width: 0.75 }
    lines.push(<line key={`f${j}`} x1={X.in + 2} y1={fy(j)} x2={X.out - 2} y2={oy(0)} stroke={st.stroke} strokeWidth={st.width} strokeDasharray="2 1.5" />)
  })
  return (
    <svg viewBox={`0 0 312 ${H}`} className="mt-1 w-full" style={{ fontSize: 7.5 }} role="img" aria-label="Its inputs, linked straight to its outputs, and what acts on its flight besides">
      {lines}
      {MIDGE_INPUTS.map((input, i) => (
        <text key={input.key} x={X.in} y={iy(i) + 2.5} textAnchor="end" fill={input.none ? '#64748b' : '#e2e8f0'}>
          <title>{`${input.label} (${RANK[input.rank]}, rank ${input.rank})${input.latch ? `: ${latchText(genes, input.latch)}` : ''}${input.vector ? `: everything of it it sees, summed as a 3D vector to the near-weighted middle of them, closer counting more (${input.elements.map((el) => el.key).join(', ')}); to steering its vector, to eat and lay its strength (how many, how near)` : ': one number; to eat and lay its value, to steering only up or down'}${input.hint ? `. ${input.hint}` : ''}${input.none ? ' (nothing yet)' : ''}`}</title>
          {input.label} <tspan fill="#94a3b8">{sig ? inputText(input, sig[`in_${input.key}`] ?? 0) : input.latch ? latchShort(genes, input.latch) : ''}</tspan>
        </text>
      ))}
      {MIDGE_INPUTS.map((input, i) => (
        <text key={`r${input.key}`} x={1} y={iy(i) + 2.2} fill={RANK_FILL[input.rank]} style={{ fontSize: 5 }}>
          {RANK[input.rank]}
        </text>
      ))}
      <text x={X.in} y={iy(NI) + 2.5} textAnchor="end" fill="#64748b" style={{ fontSize: 6.5 }}>
        fixed (not wired)
      </text>
      {FIXED.map((f, j) => {
        const text = fixedNow(f)[1]
        return (
          <text key={f.key} x={X.in} y={fy(j) + 2.5} textAnchor="end" fill="#67e8f9">
            <title>{`${f.hint}${sig && f.force ? ` Now: ${text === '–' ? 'not acting' : `${text} ${f.unit ?? 'px/s²'}`}.` : ''}`}</title>
            {f.label} <tspan fill="#94a3b8">{text}</tspan>
          </text>
        )
      })}
      {MIDGE_OUTPUTS.map((o, k) => {
        const n = neuronOf(genes, o)
        return (
          <text key={o.key} x={X.out} y={oy(k) + 2.5} fill="#e2e8f0">
            <title>{n ? `${o.label}: the sum of its links passes through its neuron (${n.type.label}: ${n.type.hint}${n.type.key === 'smooth' || n.type.key === 'change' ? `; rate ${n.rate.toFixed(2)} /s` : ''}), and the output is on above 0 (the larger of eat and lay wins).` : `${o.label}: the links' pushes add up to a force (each link's activation acting on its push's size).`}</title>
            {o.label}
            <tspan fill={RANK_FILL[o.rank]} style={{ fontSize: 5 }}>
              {' '}
              {RANK[o.rank]}
            </tspan>
            {n && (
              <tspan x={X.out} dy={7} fill={n.type.key === 'plain' ? '#64748b' : '#fbbf24'} style={{ fontSize: 6 }}>
                {neuronText(o)}
              </tspan>
            )}
            <tspan x={X.out} dy={n ? 7.5 : 9} fill={o.key === 'steer' || !sig ? '#94a3b8' : outOn(o) ? '#4ade80' : '#f87171'}>
              {outText(o)}
            </tspan>
          </text>
        )
      })}
    </svg>
  )
}

/**
 * Everything besides the wiring that acts on a midge's brain or on how it
 * evolves, so nothing acts unseen: the settings (BRAIN_PARAMS, now), the
 * constants it computes with (BRAIN_CONSTANTS), its own brain genes (its
 * neurons, its mutation genes; with `genes`), and the fixed rules.
 */
export function BrainFacts({ params, genes, title = 'Everything else acting on the brain', open = false }) {
  const row = 'flex justify-between gap-2 text-[10px]'
  const own = genes
    ? [
        ...MIDGE_OUTPUTS.filter((o) => o.neuron).map((o) => {
          const n = neuronOf(genes, o)
          return [`${o.key} neuron`, `${n.type.label}${n.type.key === 'smooth' || n.type.key === 'change' ? `, ${n.rate.toFixed(2)} /s` : ''}`, n.type.hint]
        }),
        ...LATCHES.map((l) => [l.label, latchText(genes, l), 'its source input, and where it switches on and off (genes)']),
        ...MIDGE_GENES.filter((g) => g.brainGene && !g.latch).map((g) => [g.label, `${(genes[g.key] ?? 0).toFixed(2)}${g.unit ?? ''}`, g.hint]),
        ...MIDGE_GENES.filter((g) => g.evolvability).map((g) => [g.label, `${(genes[g.key] ?? 0).toFixed(2)}${g.unit ?? ''}`, g.hint]),
        ['Colour gene', <ColourGene key="c" genes={genes} />, MIDGE_GENES.find((g) => g.seek).hint],
      ]
    : []
  return (
    <details className="group rounded-md bg-slate-800/40 p-1.5" open={open}>
      <summary className="cursor-pointer list-none text-[11px] text-slate-300">
        <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="mt-1 space-y-1.5">
        {own.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Its own (genes)</div>
            {own.map(([label, value, hint]) => (
              <div key={label} className={row} title={hint}>
                <span className="text-slate-400">{label}</span>
                <span className="font-mono tabular-nums text-amber-200">{value}</span>
              </div>
            ))}
          </div>
        )}
        {params && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Settings (every midge)</div>
            {BRAIN_PARAMS.map((b) => (
              <div key={b.key} className={row} title={b.hint}>
                <span className="text-slate-400">{b.label}</span>
                <span className="font-mono tabular-nums text-slate-200">{b.fmt(params[b.key])}</span>
              </div>
            ))}
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Constants (every midge)</div>
          {BRAIN_CONSTANTS.map((c) => (
            <div key={c.key} className={row} title={c.hint}>
              <span className="text-slate-400">{c.on}</span>
              <span className="font-mono tabular-nums text-slate-200">
                {+c.value.toFixed(4)} {c.unit}
              </span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Rules</div>
          <ul className="list-disc space-y-0.5 pl-3 text-[10px] leading-snug text-slate-400">
            {BRAIN_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <p className="text-[10px] text-slate-500">Hover a row for what it does. Below the wiring, dashed: what acts on its flight besides.</p>
      </div>
    </details>
  )
}

/** A midge's links and their weights, as a list (genes: { key: value }; has(bit)). */
export function LinkWeights({ genes, has }) {
  const rows = []
  MIDGE_INPUTS.forEach((input, i) =>
    MIDGE_OUTPUTS.forEach((o, k) => {
      if (has(linkBit(i, k))) rows.push({ key: `${i}-${k}`, label: `${input.label} → ${o.key} (${activationOf(genes, i, k).label}${gateOf(genes, i, k) ? `, ${gateText(gateOf(genes, i, k))}` : ''})`, weights: linkWeights(genes, i, k) })
    }),
  )
  if (!rows.length) return <p className="text-xs text-slate-500">No links: it does nothing.</p>
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="flex justify-between gap-2 text-xs">
          <span className="truncate text-slate-400">{r.label}</span>
          <span className="font-mono tabular-nums">
            {r.weights.map(([n, w]) => (
              <span key={n} className={`ml-2 ${w >= 0 ? 'text-green-300' : 'text-rose-300'}`}>
                {r.weights.length > 1 ? `${n} ` : ''}
                {w.toFixed(2)}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The Midges tab. `actions`: restart(profile?), apply(profile), population(); `onOpenBrain` opens the brain guide. */
export function MidgeTab({ params: p, setParam, stats, actions, onOpenBrain }) {
  const m = stats.midges
  const pop = m?.population
  // Spawning replaces whoever is there, and shows them.
  const spawnFrom = (profile) => {
    setParam('showInsects', true)
    actions.restart(profile)
  }
  return (
    <>
      <Section title="Flock">
        <Toggle label="Show midges" checked={p.showInsects} onChange={(v) => setParam('showInsects', v)} />
        <RangeModes label="Vision rings" value={p.midgeVisionMode} onChange={(v) => setParam('midgeVisionMode', v)} />
        <LogSlider label="Flock size" value={p.insectStart} min={10} max={20000} onChange={(v) => setParam('insectStart', v)} />
        <div className="grid grid-cols-[1fr_auto] gap-1">
          <button type="button" className={button} onClick={() => spawnFrom(null)} title="Replace the flock with this many midges with random brains">
            Spawn random flock
          </button>
          <button type="button" className={dangerButton} disabled={!m?.alive} onClick={() => window.confirm('Remove every midge?') && actions.clear()} title="Every midge gone at once (not counted as dying out)">
            Remove all
          </button>
        </div>
        {m && !m.population && !m.eggs && !m.extinct && <Hint>No midges yet: spawn a flock, or one from a profile or the brain guide’s examples. After that they breed by themselves.</Hint>}
        {m && (
          <>
            <StatGrid
              items={[
                ['alive', m.alive, 'text-sky-300'],
                ['eating', m.eating],
                ['down', m.down ?? 0],
                ['eggs waiting', m.eggs],
                ['eggs laid', m.laid],
                ['hatched', m.hatched, 'text-green-300'],
                ['starved', m.deaths.starved, 'text-rose-300'],
                ['old age', m.deaths.old],
                ['hit by rain', m.deaths.rain ?? 0],
              ]}
            />
            <PopulationChart history={m.history} title="Midges alive" />
            <p className="text-[10px] leading-snug text-slate-500">
              {m.extinct ? 'Extinct. ' : m.extinctions ? `Died out ${m.extinctions}× so far. ` : ''}
              {m.wasted ?? 0} clutches wasted off scum · {m.swarms} swarms · flowers: {m.dry} drunk dry, {m.resting} resting of {m.flowers} · {(m.time / 60).toFixed(1)} min
            </p>
          </>
        )}
      </Section>

      <Section title="Brain">
        <Hint>What a midge does comes from its brain: its senses wired straight to steering, eating and laying, through weights, activations, gates and a latch, all genes that evolve. Click a midge to watch its brain work live.</Hint>
        <button type="button" onClick={onOpenBrain} className="w-full rounded-md bg-sky-500/90 px-2 py-1.5 text-xs font-medium text-white hover:bg-sky-500">
          Open the brain guide
        </button>
        {pop?.wiring && (
          <Section title="The flock’s wiring" fold>
            <WiringDiagram genes={pop.genes} link={(b) => pop.wiring[b] ?? 0} />
            <Hint>Each link as opaque as the share of the living midges that have it (hover a line for its mean weights, most common activation and gate). Links going fully opaque or vanishing means selection is deciding the wiring.</Hint>
            <BrainFacts params={p} genes={pop.genes} title="Everything else acting on their brains (mean genes)" />
          </Section>
        )}
        {pop && (
          <Section title="The flock’s body genes" fold>
            <GeneTable genes={pop.genes} spread={pop.spread} list={GENES} compare={p.midgeProfile?.genes} compareLabel="profile" />
            <Hint>Mean ± spread over the living midges. A shrinking spread means selection is settling on a value.</Hint>
          </Section>
        )}
      </Section>

      <Profiles
        species="midge"
        title="Profiles"
        params={p}
        setParam={setParam}
        stats={m}
        actions={{ ...actions, restart: spawnFrom }}
        profileKey="midgeProfile"
        lockKey="midgeLocked"
        singular="midge"
        plural="midges"
        restartLabel="Spawn flock from it"
        editor={(props) => <ProfileEditor {...props} />}
      />

      <Section title="Training">
        <Toggle label="Respawn whenever they all die" checked={p.midgeTrain} onChange={(v) => setParam('midgeTrain', v)} />
        {p.midgeTrain && (
          <>
            <LogSlider label="Midges per session" value={p.midgeTrainCount} min={10} max={20000} onChange={(v) => setParam('midgeTrainCount', v)} />
            <Segmented
              value={p.midgeTrainFrom}
              options={[
                { value: 'random', label: 'Random brains' },
                { value: 'best', label: 'Best saved' },
              ]}
              onChange={(v) => setParam('midgeTrainFrom', v)}
            />
            <Hint>
              When every midge and egg is gone, the session ends: a midge of its latest generation is saved to Profiles (as “trained · gen N”) if it beats every trained profile so far, and {p.midgeTrainCount} new midges are spawned, random or mutated from the best saved. {m?.train ? `${m.train.sessions} sessions ended, ${m.train.saves} saved.` : ''}
            </Hint>
          </>
        )}
      </Section>

      <Section title="Evolution" fold>
        <Slider label="Mutations per hatchling" value={p.mutationCount} min={0} max={10} step={0.1} onChange={(v) => setParam('mutationCount', v)} />
        <Slider label="Mutation size" value={p.mutationSize} min={0} max={0.3} step={0.01} onChange={(v) => setParam('mutationSize', v)} />
        <Slider label="Multiplicative share" value={p.mutationRelative} min={0} max={1} step={0.05} onChange={(v) => setParam('mutationRelative', v)} />
        <Slider label="Sign flip chance" value={p.mutationFlip} min={0} max={0.5} step={0.01} onChange={(v) => setParam('mutationFlip', v)} unit=" /mutation" />
        <Slider label="Rewire chance" value={p.wireRate} min={0} max={0.05} step={0.001} onChange={(v) => setParam('wireRate', v)} unit=" /link" />
        <Hint>How a hatchling differs from its parent: a random number of genes change (about the mutations per hatchling, plus its own mutations gene), each by about the mutation size (plus its own gene), partly scaled and partly shifted; a few flip sign instead. Each possible link is made or broken with the rewire chance. More in the brain guide.</Hint>
        <h4 className="pt-1 text-[11px] text-slate-400">A random flock starts with</h4>
        <Slider label="Links" value={p.wireStart} min={0} max={1} step={0.05} onChange={(v) => setParam('wireStart', v)} unit=" of all" />
        <Slider label="Gates" value={p.gateStart ?? 0.3} min={0} max={1} step={0.05} onChange={(v) => setParam('gateStart', v)} unit=" of links" />
      </Section>

      <Section title="Energy and life" fold>
        <Slider label="Energy reserve" value={p.midgeEnergyMax} min={0.5} max={10} step={0.1} onChange={(v) => setParam('midgeEnergyMax', v)} unit=" e" />
        <Slider label="Feeding rate" value={p.midgeFeedRate} min={0.05} max={2} step={0.05} onChange={(v) => setParam('midgeFeedRate', v)} unit=" e/s" />
        <Slider label="Base burn" value={p.midgeBaseBurn} min={0} max={0.1} step={0.001} onChange={(v) => setParam('midgeBaseBurn', v)} unit=" /s" />
        <Slider label="Flight cost at 70 px/s" value={p.insectHunger} min={0} max={0.08} step={0.0002} onChange={(v) => setParam('insectHunger', v)} unit=" /s" />
        <Hint>A full midge holds the reserve and drinks the feeding rate on an open flower. It always burns the base rate (down or flying), plus flight cost growing with the square of its speed.</Hint>
        <Slider label="First link costs" value={p.linkCost} min={0} max={0.01} step={0.0005} onChange={(v) => setParam('linkCost', v)} unit=" /s" />
        <Slider label="Each further link costs more by" value={p.linkGrowth * 100} min={0} max={10} step={0.5} onChange={(v) => setParam('linkGrowth', v / 100)} unit=" %" />
        <Hint>The wiring burns energy all the time, whether a link acts or not; each further link costs that much more than the one before (it compounds).</Hint>
        <Slider label="Lifespan" value={p.midgeLifespan} min={10} max={600} step={5} onChange={(v) => setParam('midgeLifespan', v)} unit=" s" />
        <Slider label="Ageing past lifespan" value={p.midgeAgeing * 100} min={0} max={30} step={0.5} onChange={(v) => setParam('midgeAgeing', v / 100)} unit=" %/s" />
        <Hint>Every second past its lifespan it burns this much more and flies this much slower (compounding), until it starves of old age.</Hint>
        <Slider label="Cost per egg" value={p.eggCost} min={0} max={0.5} step={0.005} onChange={(v) => setParam('eggCost', v)} unit=" e" />
        <Slider label="Eggs hatch in" value={p.eggHatchTime} min={1} max={120} step={1} onChange={(v) => setParam('eggHatchTime', v)} unit=" s" />
        <Hint>A clutch costs its energy-per-clutch gene (shared by the hatchlings) plus this per egg.</Hint>
        <Slider label="Bodies last" value={p.insectBodyTime} min={1} max={60} step={1} onChange={(v) => setParam('insectBodyTime', v)} unit=" s" />
        <Slider label="Carried by the wind" value={p.insectWind} min={0} max={2} step={0.05} onChange={(v) => setParam('insectWind', v)} />
      </Section>

      <Section title="Flowers" fold>
        <MidgeNeeds />
        <Slider label="Nectar per flower" value={p.flowerNectar} min={0.05} max={2} step={0.05} onChange={(v) => setParam('flowerNectar', v)} unit=" meals" />
        <Slider label="Refills in" value={p.flowerRegrow} min={5} max={300} step={5} onChange={(v) => setParam('flowerRegrow', v)} unit=" s" />
        <Slider label="Refills before resting" value={p.flowerRefills} min={0} max={20} step={0.5} onChange={(v) => setParam('flowerRefills', v)} />
        <Slider label="Rest for" value={p.flowerDormancy} min={0} max={600} step={10} onChange={(v) => setParam('flowerDormancy', v)} unit=" s" />
        <Hint>Flowers fade as they are drunk and close until refilled; after about that many refills (0: never) one wilts and rests. How many there are: World → Pond → Plant mix.</Hint>
      </Section>

      <TickRate fold value={p.midgeLookEvery} onChange={(v) => setParam('midgeLookEvery', v)}>
        How often a midge senses other midges, flowers, scum and lily pads.
      </TickRate>
    </>
  )
}

/** Tiny pictures for the needs card. */
function Icon({ kind }) {
  const common = { width: 18, height: 18, viewBox: '-9 -9 18 18', className: 'shrink-0', 'aria-hidden': true }
  if (kind === 'iris' || kind === 'pickerelweed') {
    const petal = kind === 'iris' ? '#facc15' : '#a78bfa'
    return (
      <svg {...common}>
        {[0, 72, 144, 216, 288].map((a) => (
          <ellipse key={a} cx="0" cy="-4.2" rx="2.6" ry="4" fill={petal} transform={`rotate(${a})`} />
        ))}
        <circle r="2" fill="#78350f" />
      </svg>
    )
  }
  if (kind === 'pad')
    return (
      <svg {...common}>
        <path d="M0 0 L7.5 -2.5 A7.9 7.9 0 1 0 7.5 2.5 Z" fill="#65a30d" />
      </svg>
    )
  return (
    <svg {...common}>
      {[[-4, -3], [2, -5], [5, 1], [-1, 2], [-5, 4], [3, 5], [0, -1]].map(([x, y], k) => (
        <circle key={k} cx={x} cy={y} r={k % 2 ? 2.2 : 1.6} fill="#65a30d" />
      ))}
    </svg>
  )
}

/** What the midges can eat and where they can lay: the pond's offer (not yet part of how they fly). */
function MidgeNeeds() {
  const row = (title, items) => (
    <div>
      <h4 className="mb-1 text-[11px] text-slate-400">{title}</h4>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map(([kind, label]) => (
          <span key={kind} className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <Icon kind={kind} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
  return (
    <div className="space-y-2">
      {row('Can eat', [
        ['iris', 'Iris nectar'],
        ['pickerelweed', 'Pickerelweed nectar'],
      ])}
      {row('Eggs hatch on', [['scum', 'Scum mats']])}
      <Hint>They eat by coming down on an open flower with eat on, and lay by coming down with lay on; eggs laid off scum are wasted.</Hint>
    </div>
  )
}
