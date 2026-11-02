import { MIDGE_GENES as GENES, MIDGE_SENSES } from '../species/midges.js'
import { Hint, LogSlider, RangeModes, Section, Slider, TickRate, Toggle } from './controls.jsx'
import { ForceLegend, GeneTable, PopulationChart, Profiles, Vectors, button, dangerButton } from './evolution.jsx'

/** The flower colour a midge looks for (its flowerR / G / B genes, each read as 0..1), as a swatch and its hex. */
function FlowerColour({ genes, label = 'looks for flowers of' }) {
  const hex = `#${['flowerR', 'flowerG', 'flowerB'].map((k) => Math.round(255 * Math.min(1, Math.max(0, genes[k] ?? 0))).toString(16).padStart(2, '0')).join('')}`
  return (
    <div className="flex items-center gap-1.5">
      {label}
      <span className="inline-block h-2.5 w-4 rounded-sm border border-white/30" style={{ background: hex }} />
      {hex} ±{Math.max(0, genes.colourTolerance ?? 0).toFixed(2)}
    </div>
  )
}

/** Diagram rows (px), and how big a force (px/s²) or a sight count draws a line at full strength. */
const ROW = 13
const FULL_FORCE = 250
const FULL_SEEN = 8

/** A line's colour for a signed value (−1..1 at full): green positive, red negative, faint near 0. */
function flow(v) {
  const a = Math.min(1, Math.abs(v))
  if (a < 0.02) return { stroke: 'rgba(148,163,184,0.18)', width: 0.75 }
  const c = v > 0 ? '74,222,128' : '248,113,113'
  return { stroke: `rgba(${c},${0.25 + 0.75 * a})`, width: 0.75 + 1.25 * a }
}

/**
 * What the selected midge weighs, live: its inputs (what it senses and how it
 * feels), the genes each goes through, and what they drive (its steering,
 * its urge to rest, its height), as in species/midges.js. A line from an
 * input carries the input; a line from a gene carries what that gene makes
 * of it (gene × input: a force signed by its gene, a term of its urge to
 * rest), green positive, red negative, stronger the larger.
 */
function GeneDiagram({ midge }) {
  const sn = midge.senses
  if (!sn?.signals) return null
  const g = midge.genes
  const sig = sn.signals
  const seen = (k) => Math.min(1, (sn.seen?.[k] ?? 0) / FULL_SEEN)
  const force = (k, gene) => Math.sign(gene) * Math.min(1, (sn.forces?.[k] ?? 0) / FULL_FORCE)
  const inputs = [
    { key: 'midges', label: 'midges seen', v: seen('midges'), text: `${sn.seen?.midges ?? 0}` },
    { key: 'flowers', label: 'flowers', v: seen('flowers'), text: `${sn.seen?.flowers ?? 0}` },
    { key: 'scum', label: 'scum', v: seen('scum'), text: `${sn.seen?.scum ?? 0}` },
    { key: 'pads', label: 'lily pads', v: seen('pads'), text: `${sn.seen?.pads ?? 0}` },
    { key: 'rain', label: 'rain seen', v: sig.rainSeen, text: `${Math.round(sig.rainSeen * 100)}%` },
    { key: 'hunger', label: 'hunger', v: sig.hunger, text: `${Math.round(sig.hunger * 100)}%` },
    { key: 'broody', label: 'urge to lay', v: sig.broody, text: `${Math.round(sig.broody * 100)}%` },
    { key: 'threat', label: 'threat', v: sig.threat, text: `${Math.round(sig.threat * 100)}%` },
  ]
  const genes = [
    { key: 'cohesion', label: 'cohesion', from: ['midges'], to: 'steer', out: force('cohesion', g.cohesion) },
    { key: 'alignment', label: 'alignment', from: ['midges'], to: 'steer', out: force('alignment', g.alignment) },
    { key: 'separation', label: 'separation', from: ['midges'], to: 'steer', out: force('separation', g.separation) },
    { key: 'flowers', label: 'flower pull', from: ['flowers', 'hunger'], to: 'steer', out: force('flowers', g.flowers) },
    { key: 'scum', label: 'scum', from: ['scum'], to: 'steer', out: force('scum', g.scum) },
    { key: 'layAt', label: 'lays above', from: ['scum', 'broody'], to: 'steer', out: force('laying', 1) },
    { key: 'pads', label: 'lily pads', from: ['pads'], to: 'steer', out: force('pads', g.pads) },
    { key: 'rain', label: 'rain', from: ['rain'], to: 'steer', out: force('rain', g.rain) },
    { key: 'rest', label: 'rest', from: [], to: 'rest', out: g.rest },
    { key: 'restHunger', label: 'rest ← hunger', from: ['hunger'], to: 'rest', out: g.restHunger * sig.hunger },
    { key: 'restLay', label: 'rest ← laying', from: ['broody'], to: 'rest', out: g.restLay * sig.broody },
    { key: 'restRain', label: 'rest ← rain', from: ['rain'], to: 'rest', out: g.restRain * sig.rainSeen },
    { key: 'restThreat', label: 'rest ← threat', from: ['threat'], to: 'rest', out: g.restThreat * sig.threat },
    { key: 'height', label: 'flight height', from: [], to: 'height', out: Math.max(0, g.height) / 30 },
  ]
  const H = genes.length * ROW + 6
  const gy = Object.fromEntries(genes.map((n, i) => [n.key, 9 + i * ROW]))
  const iy = Object.fromEntries(inputs.map((n, i) => [n.key, 9 + (i * (genes.length - 1) * ROW) / (inputs.length - 1)]))
  const mean = (to) => {
    const ys = genes.filter((n) => n.to === to).map((n) => gy[n.key])
    return ys.reduce((a, b) => a + b, 0) / ys.length
  }
  const resting = midge.doing === 'resting'
  const outputs = [
    { key: 'steer', label: 'steering', v: Math.min(1, (sn.forces?.total ?? 0) / FULL_FORCE), text: `${(sn.forces?.total ?? 0).toFixed(0)}` },
    { key: 'rest', label: resting ? 'resting' : 'flying', v: sig.restDrive, text: `${sig.restDrive >= 0 ? '+' : ''}${sig.restDrive.toFixed(2)}` },
    { key: 'height', label: 'height', v: Math.min(1, sig.height / 30), text: `${sig.height.toFixed(0)} px` },
  ]
  const oy = Object.fromEntries(outputs.map((n) => [n.key, mean(n.key)]))
  const X = { in: 78, geneL: 104, geneR: 188, out: 212 }
  const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2))
  return (
    <details open className="border-t border-amber-400/20 pt-1.5">
      <summary className="cursor-pointer text-amber-300/70">what it weighs (live)</summary>
      <svg viewBox={`0 0 276 ${H}`} className="mt-1 w-full" style={{ fontSize: 7.5 }} role="img" aria-label="Its inputs, the genes that weigh them, and what they drive">
        {genes.flatMap((n) =>
          n.from.map((f) => {
            const st = flow(inputs.find((i) => i.key === f).v)
            return <line key={`${f}-${n.key}`} x1={X.in + 2} y1={iy[f]} x2={X.geneL - 2} y2={gy[n.key]} stroke={st.stroke} strokeWidth={st.width} />
          }),
        )}
        {genes.map((n) => {
          const st = flow(n.out)
          return <line key={`${n.key}-out`} x1={X.geneR + 2} y1={gy[n.key]} x2={X.out - 2} y2={oy[n.to]} stroke={st.stroke} strokeWidth={st.width} />
        })}
        {inputs.map((n) => (
          <text key={n.key} x={X.in} y={iy[n.key] + 2.5} textAnchor="end" fill="#e2e8f0">
            <title>{`${n.label}: ${n.text}`}</title>
            {n.label} <tspan fill="#94a3b8">{n.text}</tspan>
          </text>
        ))}
        {genes.map((n) => (
          <text key={n.key} x={X.geneL} y={gy[n.key] + 2.5} fill="#fcd34d">
            <title>{`${n.label} gene ${fmt(g[n.key])}: passes on ${n.out.toFixed(2)}`}</title>
            {n.label} <tspan fill="#94a3b8">{fmt(g[n.key])}</tspan>
          </text>
        ))}
        {outputs.map((n) => (
          <text key={n.key} x={X.out} y={oy[n.key] + 2.5} fill="#e2e8f0">
            <title>{`${n.label}: ${n.text}`}</title>
            {n.label} <tspan fill={n.key === 'rest' ? (n.v > 0 ? '#4ade80' : '#f87171') : '#94a3b8'}>{n.text}</tspan>
          </text>
        ))}
      </svg>
      <div className="text-[10px] text-slate-400">Green carries a positive value, red a negative one; brighter is stronger. It rests while the sum into rest is above 0 and takes off below −0.15.</div>
    </details>
  )
}

/** The selected midge, for the top of the panel. */
export function SelectedMidge({ midge }) {
  if (!midge) return null
  return (
    <div className="space-y-1.5 rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5 font-mono text-[11px] text-amber-200">
      <div>
        midge #{midge.id} · {midge.doing}
      </div>
      <div>
        energy {(midge.energy * 100).toFixed(0)}% · hunger {(midge.hunger * 100).toFixed(0)}%
      </div>
      <div>
        {midge.speed.toFixed(0)} px/s · sees {Math.max(0, midge.genes.vision).toFixed(0)} px
      </div>
      <div>
        age {midge.age.toFixed(0)} s of {midge.lifespan.toFixed(0)} s · lays above {(midge.genes.layAt * 100).toFixed(0)}%
      </div>
      <FlowerColour genes={midge.genes} />
      <Vectors position={midge.position} velocity={midge.velocity} />
      <ForceLegend senses={midge.senses} list={MIDGE_SENSES} />
      <GeneDiagram midge={midge} />
      <details>
        <summary className="cursor-pointer text-amber-300/70">genes</summary>
        <GeneTable genes={midge.genes} list={GENES} />
      </details>
    </div>
  )
}

/** The Midges tab. `actions`: restart(profile?), apply(profile), population(). */
export function MidgeTab({ params: p, setParam, stats, actions }) {
  const m = stats.midges
  const pop = m?.population
  // Spawning replaces whoever is there, and shows them.
  const spawnFrom = (profile) => {
    setParam('showInsects', true)
    actions.restart(profile)
  }
  const spawn = () => spawnFrom(null)
  return (
    <>
      <Section title="Midges">
        <Toggle label="Show midges" checked={p.showInsects} onChange={(v) => setParam('showInsects', v)} />
        <RangeModes label="Vision range" value={p.midgeVisionMode} onChange={(v) => setParam('midgeVisionMode', v)} />
        <div className="grid grid-cols-[1fr_auto] gap-1">
          <button type="button" className={button} onClick={spawn}>
            Spawn random flock ({p.insectStart})
          </button>
          <button
            type="button"
            className={dangerButton}
            disabled={!m?.alive}
            onClick={() => window.confirm('Remove every midge?') && actions.clear()}
            title="Every midge gone at once (not counted as dying out)"
          >
            Remove all
          </button>
        </div>
        {m && !m.population && !m.eggs && !m.extinct && <Hint>No midges yet: spawn a flock (after that they lay eggs on the scum).</Hint>}
        {m && (
          <>
            <p className="font-mono text-[11px] tabular-nums text-slate-400">
              {m.alive} alive · {m.eating} eating · {m.restingMidges ?? 0} resting · {m.swarms} swarms
              <br />
              {m.extinct ? 'extinct' : `died out ${m.extinctions}×`}
              <br />
              {m.eggs} eggs · {m.laid} laid · {m.hatched} hatched
              <br />
              died: {m.deaths.starved} starved · {m.deaths.old} of old age · {m.deaths.rain ?? 0} hit by rain
              <br />
              flowers: {m.dry} drunk dry · {m.resting} resting / {m.flowers} · {(m.time / 60).toFixed(1)} min
            </p>
            <PopulationChart history={m.history} title="Midges alive" />
          </>
        )}
      </Section>
      <TickRate value={p.midgeLookEvery} onChange={(v) => setParam('midgeLookEvery', v)}>
        How often a midge senses other midges, flowers, scum and lily pads.
      </TickRate>
      <MidgeNeeds />
      <Section title="Evolution">
        <Slider label="Mutation chance" value={p.mutationRate} min={0} max={0.5} step={0.01} onChange={(v) => setParam('mutationRate', v)} unit=" /gene" />
        <Slider label="Mutation size" value={p.mutationSize} min={0} max={0.3} step={0.01} onChange={(v) => setParam('mutationSize', v)} />
        <Slider label="Sign flip chance" value={p.mutationFlip} min={0} max={0.5} step={0.01} onChange={(v) => setParam('mutationFlip', v)} unit=" /mutation" />
        <LogSlider label="Flock size" value={p.insectStart} min={10} max={20000} onChange={(v) => setParam('insectStart', v)} />
        <Hint>
          Each midge sees within its vision gene and weighs everything it recognises by a gene of its own: other midges (cohesion, alignment, separation), flowers, scum and lily pads (+ approaches, − avoids). Flowers it knows only by their colour as drawn: each draws it by its flower gene, as much as the colour is near its own colour genes (within its tolerance), and only as hungry as it is. A flower fades as it is drunk, so a dry one looks withered, but it only finds out whether one is open by touching it. Its speed genes set how fast it cruises and its limits. Touching a flower while hungry it stops and drinks for as long as its eat-time gene says, until the flower is dry, or until something pulls it away. With energy above its laying gene scum draws it, and touching scum it lays an egg (30% of its energy); the hatchling carries its genome, mutated. Past the lifespan (World) it slows and burns more every second until it starves, so what selects is who lays the most eggs. Mutation applies to every hatchling, and when spawning from a profile; a mutation may instead flip a gene's sign (a negative flock weight steers the other way, a negative vision or speed limit counts as 0).
        </Hint>
      </Section>
      {pop && (
        <Section title="Population genes" fold>
          <div className="mb-1 font-mono text-[10px] text-slate-300">
            <FlowerColour genes={pop.genes} label="average flower colour" />
          </div>
          <GeneTable genes={pop.genes} spread={pop.spread} list={GENES} compare={p.midgeProfile?.genes} compareLabel="profile" />
          <Hint>Mean ± spread over the living midges. Shrinking spread means selection is settling on a value.</Hint>
        </Section>
      )}
      <Profiles
        species="midge"
        title="Midge profiles"
        params={p}
        setParam={setParam}
        stats={m}
        actions={{ ...actions, restart: spawnFrom }}
        profileKey="midgeProfile"
        lockKey="midgeLocked"
        singular="midge"
        plural="midges"
        restartLabel="Spawn flock from it"
      />
      <Section title="World" fold>
        <Slider label="Energy burnt" value={p.insectHunger} min={0.002} max={0.08} step={0.001} onChange={(v) => setParam('insectHunger', v)} unit=" /s" />
        <Slider label="Lifespan" value={p.midgeLifespan} min={10} max={600} step={5} onChange={(v) => setParam('midgeLifespan', v)} unit=" s" />
        <Slider label="Speed past lifespan" value={p.midgeAgeSlow} min={0.8} max={1} step={0.005} onChange={(v) => setParam('midgeAgeSlow', v)} unit=" ×/s" />
        <Slider label="Energy burn past lifespan" value={p.midgeAgeBurn} min={1} max={1.3} step={0.005} onChange={(v) => setParam('midgeAgeBurn', v)} unit=" ×/s" />
        <Hint>From hatching. Every second past the lifespan, a midge's speeds are multiplied by the first and its energy burn by the second (it compounds), until it starves of old age.</Hint>
        <Slider label="Eggs hatch in" value={p.eggHatchTime} min={1} max={120} step={1} onChange={(v) => setParam('eggHatchTime', v)} unit=" s" />
        <Slider label="Bodies last" value={p.insectBodyTime} min={1} max={60} step={1} onChange={(v) => setParam('insectBodyTime', v)} unit=" s" />
        <Slider label="Carried by the wind" value={p.insectWind} min={0} max={2} step={0.05} onChange={(v) => setParam('insectWind', v)} />
        <Hint>Energy burnt per second flying at 70 px/s (more the faster, a third of it perched); full is 1.</Hint>
        <h4 className="pt-1 text-[11px] text-slate-400">Flowers</h4>
        <Slider label="Nectar per flower" value={p.flowerNectar} min={0.05} max={2} step={0.05} onChange={(v) => setParam('flowerNectar', v)} unit=" meals" />
        <Slider label="Flower refills in" value={p.flowerRegrow} min={5} max={300} step={5} onChange={(v) => setParam('flowerRegrow', v)} unit=" s" />
        <Slider label="Refills before resting" value={p.flowerRefills} min={0} max={20} step={0.5} onChange={(v) => setParam('flowerRefills', v)} />
        <Slider label="Flowers rest for" value={p.flowerDormancy} min={0} max={600} step={10} onChange={(v) => setParam('flowerDormancy', v)} unit=" s" />
        <Hint>Flowers fade as they are drunk and close until refilled; after about that many refills (0: never) one wilts and rests, each on its own count. How many there are is set in World → Pond → Plant mix.</Hint>
      </Section>
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
    <Section title="Food and nests">
      {row('Can eat', [
        ['iris', 'Iris nectar'],
        ['pickerelweed', 'Pickerelweed nectar'],
      ])}
      {row('Can lay eggs on', [
        ['pad', 'Lily pad rims'],
        ['scum', 'Scum mats'],
      ])}
      <Hint>They eat by landing on a flower; laying eggs isn&apos;t in yet.</Hint>
    </Section>
  )
}
