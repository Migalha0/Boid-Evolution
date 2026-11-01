import { useRef, useState } from 'react'
import { downloadProfile, loadLibrary, makeProfile, parseProfile, saveLibrary } from '../sim/profiles.js'
import { Hint, Section, Toggle } from './controls.jsx'

/** Pieces both evolving species' tabs (midges, dragonflies) are made of. */

export const button = 'rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800'
const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2))

/**
 * A population over time (one series: no legend, the title names it), with
 * a crosshair and readout on hover.
 */
export function PopulationChart({ history, title = 'Midges alive', stroke = 'stroke-sky-400', fill = 'fill-sky-400' }) {
  const [hover, setHover] = useState(null)
  const W = 256
  const H = 64
  if (history.length < 2) return <p className="text-[11px] text-slate-500">Collecting samples…</p>
  const t0 = history[0][0]
  const t1 = history[history.length - 1][0]
  const top = Math.max(10, ...history.map((h) => h[1]))
  const x = (t) => ((t - t0) / Math.max(1e-6, t1 - t0)) * W
  const y = (n) => H - 2 - (n / top) * (H - 6)
  const line = history.map(([t, n]) => `${x(t).toFixed(1)},${y(n).toFixed(1)}`).join(' ')
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)
    let best = history[0]
    for (const h of history) if (Math.abs(h[0] - t) < Math.abs(best[0] - t)) best = h
    setHover(best)
  }
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]">
        <span className="text-slate-300">{title}</span>
        <span className="font-mono tabular-nums text-slate-400">
          {hover ? `${hover[1]} at ${(hover[0] / 60).toFixed(1)} min` : `last ${((t1 - t0) / 60).toFixed(0)} min`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full cursor-crosshair overflow-visible" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={y(top)} y2={y(top)} className="stroke-slate-700" strokeWidth="1" strokeDasharray="2 3" />
        <line x1="0" x2={W} y1={H - 2} y2={H - 2} className="stroke-slate-700" strokeWidth="1" />
        <text x="2" y={y(top) - 2} className="fill-slate-500 font-mono text-[8px]">
          {top}
        </text>
        <polyline points={line} fill="none" className={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover && (
          <>
            <line x1={x(hover[0])} x2={x(hover[0])} y1="0" y2={H - 2} className="stroke-slate-400" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover[0])} cy={y(hover[1])} r="3" className={`${fill} stroke-slate-900`} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  )
}

/** Genes as a compact table; `spread` adds ± columns, `compare` a second genome alongside. */
export function GeneTable({ genes, spread, compare, compareLabel, list }) {
  return (
    <table className="w-full font-mono text-[10px] tabular-nums">
      <tbody>
        {list.map((g) => (
          <tr key={g.key} title={g.hint}>
            <td className="py-px pr-2 text-slate-400">{g.label}</td>
            <td className="text-right text-slate-200">{fmt(genes[g.key])}</td>
            {spread && <td className="pl-1 text-right text-slate-500">±{fmt(spread[g.key])}</td>}
            {compare && <td className="pl-2 text-right text-amber-300/80">{fmt(compare[g.key])}</td>}
          </tr>
        ))}
      </tbody>
      {compare && (
        <tfoot>
          <tr>
            <td />
            <td className="text-right text-slate-500">now</td>
            {spread && <td />}
            <td className="pl-2 text-right text-amber-300/60">{compareLabel}</td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

/**
 * A species' saved profiles: save the population, import / export files
 * (only that species' format is accepted), choose one to give to everyone or
 * start over from, lock to it. `profileKey` / `lockKey`: the params holding
 * the chosen profile and the lock; `actions`: restart(profile?),
 * apply(profile), population(); `stats`: the species' (time, extinctions).
 */
export function Profiles({ species, title, params, setParam, stats, actions, profileKey, lockKey, plural, restartLabel }) {
  const [library, setLibrary] = useState(() => loadLibrary(species))
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const fileRef = useRef(null)
  const chosen = params[profileKey]
  const update = (list) => {
    setLibrary(list)
    saveLibrary(species, list)
  }
  const add = (profile) => {
    // Same name replaces.
    update([profile, ...library.filter((p) => p.name !== profile.name)])
    setParam(profileKey, profile)
  }
  const saveCurrent = () => {
    const pop = actions.population()
    if (!pop) return setError(`No ${plural} alive to save.`)
    setError(null)
    add(makeProfile(species, name.trim() || `${species} gen ${pop.generation.toFixed(0)} · ${new Date().toLocaleString()}`, pop, params, stats?.time ?? 0, stats?.extinctions ?? 0))
    setName('')
  }
  const importFiles = async (files) => {
    setError(null)
    for (const file of files) {
      try {
        add(parseProfile(species, await file.text()))
      } catch (e) {
        setError(`${file.name}: ${e.message}`)
      }
    }
  }
  const choose = (p) => {
    setParam(profileKey, p)
    if (!p) setParam(lockKey, false)
  }
  return (
    <Section title={title}>
      <div className="flex gap-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (optional)"
          className="min-w-0 flex-1 rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500"
        />
        <button type="button" className={button} onClick={saveCurrent}>
          Save current
        </button>
      </div>
      <div className="flex gap-1">
        <button type="button" className={button} onClick={() => fileRef.current?.click()}>
          Import .json
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" multiple hidden onChange={(e) => importFiles([...e.target.files]).then(() => (e.target.value = ''))} />
        <button type="button" className={button} disabled={!chosen} onClick={() => chosen && downloadProfile(chosen)}>
          Export chosen
        </button>
      </div>
      {error && <p className="text-[10px] text-red-300">{error}</p>}
      {library.length > 0 && (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {library.map((p) => (
            <li
              key={p.name}
              className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] ${chosen?.name === p.name ? 'bg-sky-500/15 text-sky-100' : 'text-slate-300 hover:bg-slate-800'}`}
            >
              <button type="button" className="min-w-0 flex-1 truncate text-left" title={`generation ${p.generation}, ${p.population} ${plural}, ${Math.round((p.trainedSeconds ?? 0) / 60)} min`} onClick={() => choose(chosen?.name === p.name ? null : p)}>
                {p.name}
              </button>
              <button
                type="button"
                className="text-slate-500 hover:text-red-300"
                title="Delete"
                onClick={() => {
                  update(library.filter((q) => q.name !== p.name))
                  if (chosen?.name === p.name) choose(null)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen && (
        <>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" className={button} onClick={() => actions.apply(chosen)} title={`Every living one of the ${plural} takes this genome`}>
              Give to all
            </button>
            <button type="button" className={button} onClick={() => actions.restart(chosen)} title="Start over from this genome">
              {restartLabel}
            </button>
          </div>
          <Toggle label={`Lock to “${chosen.name}”`} checked={params[lockKey]} onChange={(v) => setParam(lockKey, v)} />
        </>
      )}
      <Hint>
        Save the population&apos;s mean genome as a {species} profile, or import one (from here or <code>npm run train</code>); only {species} profiles are accepted. Choose one to give it to the {plural} or start over from it; locked, every one carries it exactly and nothing mutates.
      </Hint>
    </Section>
  )
}
