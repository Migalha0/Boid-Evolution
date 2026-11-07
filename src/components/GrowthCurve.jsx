import { useRef, useState } from 'react'
import { evalCurve } from '../sim/curve.js'
import { GROWTH_DEFAULT, SHORE_X } from '../sim/PondMap.js'
import { MURK_DEFAULT } from '../config/defaults.js'

/** Drawing area (svg units) and margins; values run 0..yMax up the side. */
const W = 280
const H = 130
const L = 22
const R = 6
const T = 8
const B = 22
/** Closest two points may come (x), and how near (svg units) a click must be to grab one. */
const MIN_GAP = 0.03
const GRAB = 9

const sx = (x) => L + x * (W - L - R)

/**
 * A curve of points [[x, y], ...] over x 0..1 (sim/curve.js): drag a point to
 * move it (the two ends only up and down), click on the curve's area to add
 * one, double-click (or right-click) one to remove it. `ground` draws behind
 * it (svg, given the plot's box), `yTicks` are [value, label] lines, `xLabels`
 * [x, label, anchor] along the bottom, `marks` x positions of dashed guides.
 */
function CurveEditor({ title, points, onChange, initial, yMax, yTicks, xLabels, marks = [], ground, label }) {
  const sy = (y) => T + (1 - y / yMax) * (H - T - B)
  const svg = useRef(null)
  const [drag, setDrag] = useState(-1)
  const [hover, setHover] = useState(-1)

  const toCurve = (e) => {
    const r = svg.current.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const py = ((e.clientY - r.top) / r.height) * H
    return [Math.min(1, Math.max(0, (px - L) / (W - L - R))), Math.min(yMax, Math.max(0, (1 - (py - T) / (H - T - B)) * yMax)), px, py]
  }
  const nearest = (px, py) => {
    let best = -1
    let bestD = GRAB
    points.forEach(([x, y], i) => {
      const d = Math.hypot(sx(x) - px, sy(y) - py)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const round = (v) => Math.round(v * 100) / 100

  const move = (i, x, y) => {
    const next = points.map((p) => [...p])
    const last = points.length - 1
    // The ends stay at the ends; others keep between their neighbours.
    next[i][0] = i === 0 ? 0 : i === last ? 1 : round(Math.min(points[i + 1][0] - MIN_GAP, Math.max(points[i - 1][0] + MIN_GAP, x)))
    next[i][1] = round(y)
    onChange(next)
  }

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    const [x, y, px, py] = toCurve(e)
    let i = nearest(px, py)
    if (i < 0) {
      // A new point here, if there is room between its neighbours.
      const at = points.findIndex(([px0]) => px0 > x)
      if (at <= 0 || x - points[at - 1][0] < MIN_GAP || points[at][0] - x < MIN_GAP) return
      onChange([...points.slice(0, at), [round(x), round(y)], ...points.slice(at)])
      i = at
    }
    svg.current.setPointerCapture(e.pointerId)
    setDrag(i)
  }
  const onPointerMove = (e) => {
    const [x, y, px, py] = toCurve(e)
    if (drag >= 0) move(drag, x, y)
    else setHover(nearest(px, py))
  }
  const remove = (e) => {
    e.preventDefault()
    const [, , px, py] = toCurve(e)
    const i = nearest(px, py)
    if (i > 0 && i < points.length - 1) onChange(points.filter((_, k) => k !== i))
  }

  const curve = Array.from({ length: 81 }, (_, k) => {
    const x = k / 80
    return `${k ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(Math.min(yMax, evalCurve(points, x))).toFixed(1)}`
  }).join('')
  const shown = drag >= 0 ? drag : hover

  return (
    <div>
      <div className="mb-1 text-xs text-slate-300">{title}</div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none rounded border border-white/10"
        style={{ cursor: drag >= 0 ? 'grabbing' : hover >= 0 ? 'grab' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(-1)}
        onPointerLeave={() => drag < 0 && setHover(-1)}
        onDoubleClick={remove}
        onContextMenu={remove}
        role="img"
        aria-label={label}
      >
        {ground({ x: L, y: T, width: W - L - R, height: H - T - B })}
        {marks.map((x) => (
          <line key={x} x1={sx(x)} x2={sx(x)} y1={T} y2={H - B} stroke="#94a3b8" strokeOpacity="0.35" strokeDasharray="2 2" />
        ))}
        {yTicks.map(([y, t]) => (
          <g key={y}>
            {y > 0 && <line x1={L} x2={W - R} y1={sy(y)} y2={sy(y)} stroke="#94a3b8" strokeOpacity={t ? 0.35 : 0.15} />}
            <text x={L - 3} y={sy(y) + 3} textAnchor="end" fontSize="8" fill="#64748b">
              {t || y}
            </text>
          </g>
        ))}
        {xLabels.map(([x, t, anchor]) => (
          <text key={t} x={sx(x)} y={H - 8} textAnchor={anchor} fontSize="8.5" fill="#94a3b8">
            {t}
          </text>
        ))}
        <path d={`${curve}L${sx(1)},${sy(0)}L${sx(0)},${sy(0)}Z`} fill="#84cc16" fillOpacity="0.18" />
        <path d={curve} fill="none" stroke="#a3e635" strokeWidth="1.5" />
        {points.map(([x, y], i) => (
          <circle key={i} cx={sx(x)} cy={sy(Math.min(yMax, y))} r={i === shown ? 4.5 : 3.5} fill={i === shown ? '#ecfccb' : '#bef264'} stroke="#1a2e05" strokeWidth="1" />
        ))}
      </svg>
      <div className="mt-1 flex justify-end">
        <button type="button" className="text-[10px] text-slate-400 hover:text-slate-200" onClick={() => onChange(initial)}>
          Reset curve
        </button>
      </div>
    </div>
  )
}

/**
 * The growth curve (params plantGrowth, sim/PondMap.js): how much grows from
 * inland, through the shore and the shallows, out to deep water.
 */
export function GrowthCurve({ points, onChange }) {
  return (
    <CurveEditor
      title="Growth"
      label="Growth curve: how much grows from inland to deep water"
      points={points}
      onChange={onChange}
      initial={GROWTH_DEFAULT}
      yMax={1.5}
      yTicks={[
        [0, ''],
        [0.5, ''],
        [1, 'full'],
      ]}
      xLabels={[
        [0.02, 'inland', 'start'],
        [SHORE_X, 'shore', 'middle'],
        [0.62, 'shallows', 'middle'],
        [0.99, 'deep', 'end'],
      ]}
      marks={[SHORE_X]}
      ground={(box) => (
        <>
          <defs>
            <linearGradient id="growth-ground" x1="0" x2="1">
              <stop offset="0" stopColor="#3b3226" />
              <stop offset={SHORE_X} stopColor="#2a251c" />
              <stop offset={SHORE_X} stopColor="#3a3d26" />
              <stop offset="0.6" stopColor="#25301f" />
              <stop offset="1" stopColor="#0f1914" />
            </linearGradient>
          </defs>
          <rect {...box} fill="url(#growth-ground)" opacity="0.8" />
        </>
      )}
    />
  )
}

/**
 * The murk curve (params murkCurve, render/shaders.js murkAt): how far
 * something has faded into the water at each depth, from just under the
 * surface to the deepest floor (0 clear, 1 lost). Fish, the floor, its
 * shadows, sunken trunks and the water's own colour all follow it.
 */
export function MurkCurve({ points, onChange }) {
  return (
    <CurveEditor
      title="Murk by depth"
      label="Murk curve: how much things fade into the water at each depth"
      points={points}
      onChange={onChange}
      initial={MURK_DEFAULT}
      yMax={1}
      yTicks={[
        [0, 'clear'],
        [0.5, ''],
        [1, 'lost'],
      ]}
      xLabels={[
        [0.01, 'surface', 'start'],
        [0.5, 'middle', 'middle'],
        [0.99, 'deepest floor', 'end'],
      ]}
      ground={(box) => (
        <>
          <defs>
            <linearGradient id="murk-ground" x1="0" x2="1">
              <stop offset="0" stopColor="#3a3d26" />
              <stop offset="0.5" stopColor="#1f2a1c" />
              <stop offset="1" stopColor="#0b1210" />
            </linearGradient>
          </defs>
          <rect {...box} fill="url(#murk-ground)" opacity="0.8" />
        </>
      )}
    />
  )
}
