import { useMemo, useState } from 'react'
import { geneLimit } from '../sim/genetics.js'
import { handmadeGenes, PRESETS } from '../sim/handmade.js'
import { ACTIVATIONS, activationKey, gateInputKey, gateKey, GATES, gateThresholdKey, linkBit, MIDGE_GENES, MIDGE_INPUTS, MIDGE_OUTPUTS, NODE_TYPES, nodeKey, RANK, rateKey, seekColour, weightKey, wiresFrom, wiresOf } from '../species/midges.js'
import { Hint } from './controls.jsx'
import { button } from './evolution.jsx'
import { ColourGene, WiringDiagram } from './MidgePanel.jsx'

/** Body genes the editor shows as numbers: everything but the wiring, its weights and activations, and the neurons (edited per output below). */
const BODY = MIDGE_GENES.filter((g) => !g.wires && !g.weight && !g.activation && !g.gate && !g.node && !g.fixed && !g.seek && !g.brainGene)
/** The brain's own genes besides its links and neurons: its latches (source, on, off) and its wander rate. */
const BRAIN = MIDGE_GENES.filter((g) => g.brainGene)
const BITS = MIDGE_INPUTS.length * MIDGE_OUTPUTS.length

const input = 'w-full rounded bg-slate-800 px-1 py-0.5 font-mono text-[10px] tabular-nums text-slate-100'
const select = 'rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-100'

/** A number field for a gene, within ±its limit (its range for `relative` genes), kept as typed until it is a number. */
function Num({ value, onChange, gene, step = 0.05, title }) {
  const [text, setText] = useState(null)
  const lo = gene?.relative ? gene.min : gene ? -geneLimit(gene) : -Infinity
  const hi = gene?.relative ? gene.max : gene ? geneLimit(gene) : Infinity
  return (
    <input
      type="number"
      className={input}
      step={step}
      min={lo}
      max={hi}
      title={title}
      value={text ?? +(+value).toFixed(3)}
      onChange={(e) => {
        setText(e.target.value)
        const v = parseFloat(e.target.value)
        if (Number.isFinite(v)) onChange(Math.min(hi, Math.max(lo, v)))
      }}
      onBlur={() => setText(null)}
    />
  )
}

/**
 * Make a midge profile by hand: start from nothing, the chosen profile or a
 * preset (sim/handmade.js), set its body genes, its eat and lay neurons and
 * every link (on or off, its activation, a weight per element of its input),
 * and save it to the library (and spawn a flock from it). The diagram shows
 * the wiring as it stands.
 *
 * `chosen`: the profile chosen in the library (or null); `save(profile,
 * spawn)`: adds it to the library, and with spawn starts a flock from it.
 */
export function ProfileEditor({ chosen, save, makeProfile }) {
  const blank = useMemo(() => handmadeGenes({}), [])
  const [genes, setGenes] = useState(blank)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('blank')
  const has = wiresOf(genes)
  const set = (key, v) => setGenes((g) => ({ ...g, [key]: v }))
  const toggle = (b) =>
    setGenes((g) => {
      const on = wiresOf(g)
      const bits = []
      for (let k = 0; k < BITS; k++) if (k === b ? !on(k) : on(k)) bits.push(k)
      return { ...g, ...wiresFrom(bits) }
    })
  const start = (label, g, n = '') => {
    // Every gene present: a profile from before a gene existed gets that gene's blank value.
    setGenes({ ...blank, ...g })
    setName(n)
    setFrom(label)
  }
  const linkCount = Array.from({ length: BITS }, (_, b) => has(b)).filter(Boolean).length
  const finish = (spawn) => {
    const n = name.trim() || `hand-made · ${new Date().toLocaleString()}`
    save(makeProfile(n, genes), spawn)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
        Start from:
        <button type="button" className={`${button} ${from === 'blank' ? 'ring-1 ring-sky-400/60' : ''}`} onClick={() => start('blank', blank)}>
          Blank
        </button>
        <button type="button" className={`${button} ${from === 'chosen' ? 'ring-1 ring-sky-400/60' : ''}`} disabled={!chosen} onClick={() => start('chosen', chosen.genes, chosen.name)} title={chosen ? `The chosen profile, “${chosen.name}”` : 'Choose a profile in the library first'}>
          Chosen
        </button>
        {PRESETS.map((p) => (
          <button key={p.name} type="button" className={`${button} ${from === p.name ? 'ring-1 ring-sky-400/60' : ''}`} onClick={() => start(p.name, handmadeGenes(p), p.name)} title={p.text}>
            {p.name}
          </button>
        ))}
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="profile name" className="w-full rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500" />

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Body</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {BODY.map((g) => (
            <label key={g.key} className="space-y-0.5" title={g.hint}>
              <span className="block truncate text-[10px] text-slate-400">
                {g.label}
                {g.unit ? <span className="text-slate-500">{g.unit}</span> : null}
              </span>
              <Num value={genes[g.key] ?? 0} gene={g} step={(g.max - g.min) / 100} onChange={(v) => set(g.key, v)} />
            </label>
          ))}
        </div>
        <label className="mt-1 flex items-center justify-between text-[10px] text-slate-400" title="its colour gene: “coloured things” sees only flower heads near this colour (it mutates)">
          Colour gene
          <span className="flex items-center gap-1.5">
            <ColourGene genes={genes} />
            <input
              type="color"
              className="h-5 w-8 cursor-pointer rounded border border-slate-600 bg-transparent"
              value={`#${seekColour(genes).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`}
              onChange={(e) => {
                const hex = e.target.value
                ;['seekRed', 'seekGreen', 'seekBlue'].forEach((key, k) => set(key, parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16) / 255))
              }}
            />
          </span>
        </label>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Brain genes</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {BRAIN.map((g) => (
            <label key={g.key} className="space-y-0.5" title={g.hint}>
              <span className="block truncate text-[10px] text-slate-400">
                {g.label}
                {g.unit ? <span className="text-slate-500">{g.unit}</span> : null}
              </span>
              {g.choices ? (
                <select className={`${select} w-full`} value={Math.round(genes[g.key] ?? 0)} onChange={(e) => set(g.key, +e.target.value)}>
                  {MIDGE_INPUTS.map((inp, k) => (
                    <option key={inp.key} value={k}>
                      {inp.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Num value={genes[g.key] ?? 0} gene={g} step={g.relative ? 0.1 : 0.05} onChange={(v) => set(g.key, v)} />
              )}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Wiring ({linkCount} links)</div>
        <WiringDiagram genes={genes} link={(b) => (has(b) ? 1 : 0)} />
      </div>

      {MIDGE_OUTPUTS.map((out, o) => (
        <div key={out.key} className="space-y-1 rounded-md bg-slate-800/40 p-1.5">
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-slate-200">
            <span className="mr-auto">
              → {out.label} <span className={`text-[9px] ${out.rank ? 'text-violet-300' : 'text-amber-300'}`}>{RANK[out.rank]}</span>
            </span>
            {out.neuron && (
              <>
                <span className="text-[10px] text-slate-500">neuron</span>
                <select className={select} value={Math.round(genes[nodeKey(out.key)] ?? 0)} onChange={(e) => set(nodeKey(out.key), +e.target.value)} title={NODE_TYPES[Math.round(genes[nodeKey(out.key)] ?? 0)]?.hint}>
                  {NODE_TYPES.map((n, k) => (
                    <option key={n.key} value={k}>
                      {n.label}
                    </option>
                  ))}
                </select>
                <span className="w-12">
                  <Num value={genes[rateKey(out.key)] ?? 1} gene={MIDGE_GENES.find((g) => g.key === rateKey(out.key))} step={0.1} onChange={(v) => set(rateKey(out.key), v)} title="its rate (per s): smooth and change only" />
                </span>
              </>
            )}
          </div>
          {MIDGE_INPUTS.map((inp, i) => {
            const b = linkBit(i, o)
            const on = has(b)
            return (
              <div key={inp.key} className={`text-[10px] ${on ? 'text-slate-200' : 'text-slate-500'}`}>
                <div className="flex items-center gap-1">
                  <label className="flex min-w-0 flex-1 items-center gap-1" title={inp.hint ?? inp.label}>
                    <input type="checkbox" checked={on} onChange={() => toggle(b)} />
                    <span className="truncate">{inp.label}</span>
                    <span className={`shrink-0 text-[9px] ${inp.rank ? 'text-violet-300' : 'text-amber-300'}`}>{RANK[inp.rank]}</span>
                  </label>
                  {on && (
                    <select className={select} value={Math.round(genes[activationKey(i, o)] ?? 0)} onChange={(e) => set(activationKey(i, o), +e.target.value)} title={ACTIVATIONS[Math.round(genes[activationKey(i, o)] ?? 0)]?.hint}>
                      {ACTIVATIONS.map((a, k) => (
                        <option key={a.key} value={k}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {on && (
                  <div className="ml-5 mt-0.5 flex items-center gap-1">
                    <span className="text-slate-500">gate</span>
                    <select className={select} value={Math.round(genes[gateKey(i, o)] ?? 0)} onChange={(e) => set(gateKey(i, o), +e.target.value)} title={GATES[Math.round(genes[gateKey(i, o)] ?? 0)]?.hint}>
                      {GATES.map((g, k) => (
                        <option key={g.key} value={k}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                    {Math.round(genes[gateKey(i, o)] ?? 0) > 0 && (
                      <select className={select} value={Math.round(genes[gateInputKey(i, o)] ?? 0)} onChange={(e) => set(gateInputKey(i, o), +e.target.value)} title="its gate input: a scalar's value, a vector's strength, clamped to 0..1">
                        {MIDGE_INPUTS.map((g, k) => (
                          <option key={g.key} value={k}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {GATES[Math.round(genes[gateKey(i, o)] ?? 0)]?.threshold && (
                      <span className="w-12" title="its threshold t: IF, UNLESS and FLIP switch where the gate input crosses it">
                        <Num value={genes[gateThresholdKey(i, o)] ?? 0.5} gene={MIDGE_GENES.find((g) => g.key === gateThresholdKey(i, o))} step={0.05} onChange={(v) => set(gateThresholdKey(i, o), v)} />
                      </span>
                    )}
                  </div>
                )}
                {on && (
                  <div className="mb-1 ml-5 mt-0.5 grid grid-cols-3 gap-1">
                    {inp.elements.map((el) => {
                      const key = weightKey(i, el.key, o)
                      return (
                        <label key={el.key} className="flex items-center gap-1" title={`weight on ${inp.number ? inp.label : `${inp.label} (${el.key})`}`}>
                          {inp.elements.length > 1 && <span className="shrink-0 text-slate-500">{el.key[0]}</span>}
                          <span className="min-w-0 flex-1">
                            <Num value={genes[key] ?? 0} gene={MIDGE_GENES.find((g) => g.key === key)} onChange={(v) => set(key, v)} />
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-1">
        <button type="button" className={button} onClick={() => finish(false)}>
          Save to library
        </button>
        <button type="button" className={button} onClick={() => finish(true)}>
          Save and spawn flock
        </button>
      </div>
      <Hint>
        Tick a link to make it, then pick its activation and a weight for each element of its input (midges: where / heading; the rest one each). Weights reach ±3. Hover anything for what it does. Saved, it joins the library as a hand-made profile (exact genes, like one individual); a spawned flock mutates from it unless the profile is locked.
      </Hint>
    </div>
  )
}
