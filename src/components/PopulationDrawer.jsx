import { useState } from 'react'
import { FADE_TRANSITION, FADED, useIdleFade } from './useIdleFade.js'

/**
 * Every kind of creature's numbers over time on one graph, in a drawer that
 * hides at the bottom of the screen and slides up while its tab is hovered.
 * One shared y axis, log by default since the counts differ by orders of
 * magnitude. Colours: the first categorical slots (dark
 * steps), validated all-pairs against the dark surface; each line also ends
 * in its creature's icon, so identity never rests on colour alone.
 */

const SERIES = [
  { key: 'fish', index: 1, label: 'Fish', colour: '#3987e5', Icon: FishIcon },
  { key: 'midges', index: 2, label: 'Midges', colour: '#199e70', Icon: MidgeIcon },
]

const W = 640
const H = 190
const PAD = { left: 40, right: 26, top: 12, bottom: 22 }

/** Icons drawn in a ~18 px box centred on the origin, filled with `colour` and ringed with the surface. */
function FishIcon({ colour }) {
  return (
    <g fill={colour} className="stroke-slate-900" strokeWidth="1.5" paintOrder="stroke">
      <path d="M-3.5 0 L-8 -4 L-8 4 Z" />
      <ellipse cx="1" cy="0" rx="6" ry="3.4" />
    </g>
  )
}
function MidgeIcon({ colour }) {
  return (
    <g fill={colour} className="stroke-slate-900" strokeWidth="1.5" paintOrder="stroke">
      <ellipse cx="-3" cy="-2" rx="3.2" ry="1.6" transform="rotate(30 -3 -2)" opacity="0.75" />
      <ellipse cx="3" cy="-2" rx="3.2" ry="1.6" transform="rotate(-30 3 -2)" opacity="0.75" />
      <ellipse cx="0" cy="1" rx="1.6" ry="4" />
    </g>
  )
}
/** An icon as a standalone inline SVG, for the legend and the tab. */
function Badge({ series, size = 16 }) {
  const { Icon, colour } = series
  return (
    <svg width={size} height={size} viewBox="-9 -9 18 18" className="shrink-0" aria-hidden="true">
      <Icon colour={colour} />
    </svg>
  )
}

const fmtCount = (n) => (n == null ? '–' : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const fmtTime = (t) => `${(t / 60).toFixed(t < 600 ? 1 : 0)} min`

export default function PopulationDrawer({ history = [] }) {
  const [log, setLog] = useState(true)
  const [hover, setHover] = useState(null)
  // Its tab, left alone for a while, all but disappears (the drawer opens on hover, so that resets it).
  const [faded, fadeHandlers] = useIdleFade(true)
  const last = history[history.length - 1]
  // Only kinds that have been in the sim at some point in the window.
  const shown = SERIES.filter((s) => history.some((h) => h[s.index] != null && h[s.index] > 0) || (last && last[s.index] > 0))

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4">
      <div
        className="group pointer-events-auto w-full max-w-[680px] translate-y-[calc(100%-2rem)] transition-transform duration-300 ease-out hover:translate-y-0 focus-within:translate-y-0"
        onPointerEnter={fadeHandlers.onPointerEnter}
        onPointerLeave={(e) => {
          setHover(null)
          fadeHandlers.onPointerLeave(e)
        }}
      >
        <button
          type="button"
          className={`mx-auto flex h-8 items-center gap-3 rounded-t-lg border border-b-0 px-3 text-[11px] text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${FADE_TRANSITION} ${faded ? FADED : 'border-slate-700/60 bg-slate-900/95'}`}
          aria-label="Population graph"
        >
          <span className="text-slate-400 transition-transform duration-300 group-hover:rotate-180">▲</span>
          <span>Populations</span>
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1 font-mono tabular-nums text-slate-400">
              <Badge series={s} size={14} />
              {fmtCount(last?.[s.index])}
            </span>
          ))}
        </button>
        <div className="rounded-t-xl border border-b-0 border-slate-700/60 bg-slate-900/95 p-3 shadow-2xl">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="text-slate-200">Alive over time</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1" role="list" aria-label="Legend">
              {SERIES.map((s) => (
                <span key={s.key} role="listitem" className={`flex items-center gap-1.5 ${shown.includes(s) ? 'text-slate-300' : 'text-slate-600'}`}>
                  <Badge series={s} />
                  {s.label}
                  <span className="font-mono tabular-nums text-slate-400">{fmtCount(last?.[s.index])}</span>
                </span>
              ))}
            </div>
            <div className="ml-auto flex overflow-hidden rounded-md border border-slate-700 text-[10px]">
              {[
                [true, 'log'],
                [false, 'linear'],
              ].map(([v, name]) => (
                <button key={name} type="button" onClick={() => setLog(v)} className={`px-2 py-0.5 ${log === v ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800'}`}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          <Chart history={history} shown={shown} log={log} hover={hover} setHover={setHover} />
        </div>
      </div>
    </div>
  )
}

function Chart({ history, shown, log, hover, setHover }) {
  if (history.length < 2) return <p className="py-8 text-center text-[11px] text-slate-500">Collecting samples…</p>
  if (!shown.length) return <p className="py-8 text-center text-[11px] text-slate-500">Nothing alive yet: spawn fish or midges.</p>
  const t0 = history[0][0]
  const t1 = history[history.length - 1][0]
  let top = 1
  for (const h of history) for (const s of shown) if (h[s.index] != null) top = Math.max(top, h[s.index])
  // Log axis over 0, 1, 10, 100…; linear over a rounded top.
  const decades = Math.max(1, Math.ceil(Math.log10(top + 1)))
  const niceTop = (() => {
    const step = 10 ** Math.floor(Math.log10(top))
    return Math.ceil(top / step) * step
  })()
  const scale = log ? (n) => Math.log10(1 + n) / decades : (n) => n / niceTop
  const ticks = log ? [0, ...Array.from({ length: decades + 1 }, (_, k) => 10 ** k)].filter((v) => scale(v) <= 1.0001) : [0, niceTop / 4, niceTop / 2, (niceTop * 3) / 4, niceTop]
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const x = (t) => PAD.left + ((t - t0) / Math.max(1e-6, t1 - t0)) * iw
  const y = (n) => PAD.top + ih - scale(n) * ih
  // Lines broken where a kind was out of the sim (null).
  const paths = shown.map((s) => {
    let d = ''
    let pen = false
    for (const h of history) {
      const n = h[s.index]
      if (n == null) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(h[0]).toFixed(1)},${y(n).toFixed(1)}`
      pen = true
    }
    return d
  })
  // About five time ticks at whole minutes.
  const span = (t1 - t0) / 60
  const every = [0.5, 1, 2, 5, 10, 20].find((m) => span / m <= 5) ?? 30
  const timeTicks = []
  for (let m = Math.ceil(t0 / 60 / every) * every; m <= t1 / 60; m += every) timeTicks.push(m * 60)

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + (((e.clientX - r.left) / r.width) * W - PAD.left) / iw * (t1 - t0)
    let best = history[0]
    for (const h of history) if (Math.abs(h[0] - t) < Math.abs(best[0] - t)) best = h
    setHover(best)
  }
  const lastRow = history[history.length - 1]
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full cursor-crosshair touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Population of each kind over time">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-slate-800" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
              {fmtCount(v)}
            </text>
          </g>
        ))}
        {timeTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="fill-slate-500 font-mono text-[9px]">
            {fmtTime(t)}
          </text>
        ))}
        {shown.map((s, k) => (
          <path key={s.key} d={paths[k]} fill="none" stroke={s.colour} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* Each line ends in its creature's icon. */}
        {shown.map((s) =>
          lastRow[s.index] == null ? null : (
            <g key={s.key} transform={`translate(${x(lastRow[0]) + 10},${y(lastRow[s.index])})`}>
              <s.Icon colour={s.colour} />
            </g>
          ),
        )}
        {hover && (
          <g>
            <line x1={x(hover[0])} x2={x(hover[0])} y1={PAD.top} y2={PAD.top + ih} className="stroke-slate-500" strokeWidth="1" />
            {shown.map((s) =>
              hover[s.index] == null ? null : <circle key={s.key} cx={x(hover[0])} cy={y(hover[s.index])} r="4" fill={s.colour} className="stroke-slate-900" strokeWidth="2" />,
            )}
          </g>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-slate-700 bg-slate-950/95 px-2 py-1 text-[11px] shadow-lg"
          style={{ left: `${(x(hover[0]) / W) * 100}%`, transform: `translateX(${x(hover[0]) > W / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
        >
          <div className="mb-0.5 font-mono text-slate-400">{fmtTime(hover[0])}</div>
          {shown.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-slate-300">
              <Badge series={s} size={12} />
              {s.label}
              <span className="ml-auto pl-3 font-mono tabular-nums text-slate-100">{fmtCount(hover[s.index])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
