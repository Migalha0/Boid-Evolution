import { useRef, useState } from 'react'
import { MAX_BOIDS } from '../gpu/GpuBoidSim.js'
import { Hint, LogSlider, Section, Slider, Toggle } from './controls.jsx'
import { DragonflyTab, SelectedDragonfly } from './DragonflyPanel.jsx'
import { MidgeTab, SelectedMidge } from './MidgePanel.jsx'

/** Knob sweep for value dials (range mode): -135°..135°, gap at the bottom. */
const SWEEP = 135

/**
 * Circular dial. Without `range` it is an angle picker (compass bearing: 0° =
 * up, clockwise, wraps around). With `range = [min, max]` it is a knob whose
 * pointer sweeps 270° from min to max. Drag it or use the arrow keys.
 */
function Dial({ label, value, onChange, step = 1, range, unit = '°', knob = 'fill-amber-300 stroke-amber-100', hand = 'stroke-amber-300/60' }) {
  const ref = useRef(null)
  const size = 64
  const c = size / 2
  const r = size / 2 - 7
  const [min, max] = range ?? [0, 360]
  const toDeg = (v) => (range ? -SWEEP + ((v - min) / (max - min)) * 2 * SWEEP : v)
  const at = (deg, radius) => {
    const a = (deg * Math.PI) / 180
    return [c + Math.sin(a) * radius, c - Math.cos(a) * radius]
  }
  const [kx, ky] = at(toDeg(value), r)
  const set = (v) => {
    v = Math.round(v / step) * step
    onChange(range ? Math.min(max, Math.max(min, v)) : ((v % 360) + 360) % 360)
  }
  const fromPointer = (e) => {
    const b = ref.current.getBoundingClientRect()
    const deg = (Math.atan2(e.clientX - (b.left + b.width / 2), -(e.clientY - (b.top + b.height / 2))) * 180) / Math.PI
    if (!range) return set(deg)
    // In the gap at the bottom, snap to the nearer end.
    const d = Math.max(-SWEEP, Math.min(SWEEP, deg))
    set(min + ((d + SWEEP) / (2 * SWEEP)) * (max - min))
  }
  const [ax, ay] = at(-SWEEP, r)
  const [bx, by] = at(SWEEP, r)
  return (
    <div className="flex items-center justify-between">
      <div className="text-xs">
        <div className="text-slate-300">{label}</div>
        <div className="font-mono tabular-nums text-slate-400">
          {value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}
          {unit}
        </div>
      </div>
      <svg
        ref={ref}
        width={size}
        height={size}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={range ? max : 359}
        aria-valuenow={value}
        className="cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400 active:cursor-grabbing"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          fromPointer(e)
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromPointer(e)}
        onKeyDown={(e) => {
          const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]
          if (d) {
            e.preventDefault()
            set(value + d * (range ? Math.max(step, (max - min) / 20) : 5))
          }
        }}
      >
        <circle cx={c} cy={c} r={r} className="fill-slate-800 stroke-slate-600" strokeWidth={1.5} />
        {range ? (
          <path
            d={`M ${ax} ${ay} A ${r} ${r} 0 1 1 ${bx} ${by}`}
            className="fill-none stroke-slate-500"
            strokeWidth={3}
            strokeLinecap="round"
          />
        ) : (
          <>
            {[0, 90, 180, 270].map((a) => {
              const [x1, y1] = at(a, r - 4)
              const [x2, y2] = at(a, r)
              return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-slate-500" strokeWidth={1.5} />
            })}
            <text x={c} y={15} textAnchor="middle" className="fill-slate-500 text-[8px]">
              N
            </text>
          </>
        )}
        <line x1={c} y1={c} x2={kx} y2={ky} className={hand} strokeWidth={1.5} />
        <circle cx={kx} cy={ky} r={5} className={knob} strokeWidth={1} />
      </svg>
    </div>
  )
}

const TABS = ['Fish', 'Midges', 'Dragonflies', 'Pond', 'Water', 'Sky', 'View']

const ms = (v) => (v == null ? 'n/a' : `${v.toFixed(2)} ms`)

function Segmented({ value, options, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-800/80 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            value === o.value ? 'bg-sky-500/90 text-white' : 'text-slate-300 hover:bg-slate-700'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function ControlPanel({ params, setParam, stats, onReset, onNewMap, onShuffleLogs, onDefaults, midgeActions, dragonflyActions }) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState(TABS[0])
  const p = params

  return (
    <aside className="pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-72 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/95 shadow-2xl">
      <header className="flex items-center justify-between border-b border-slate-700/60 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Boids</h2>
          <p className="font-mono text-[11px] tabular-nums text-slate-400">
            {stats.fps.toFixed(0)} fps · {stats.count.toLocaleString()} boids
          </p>
          <p className="font-mono text-[11px] tabular-nums text-slate-500" title="GPU time to simulate and draw one frame (measured synchronously where the GPU cannot time itself). The fps above is capped by the display's refresh rate.">
            frame {ms(stats.frameMs)}
            {stats.frameMs != null && ` · ~${Math.round(1000 / stats.frameMs)} fps max`}
          </p>
          {stats.gpuSimMs != null && (
            <p className="font-mono text-[11px] tabular-nums text-slate-500">
              gpu sim {ms(stats.gpuSimMs)} · draw {ms(stats.gpuRenderMs)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </header>

      {open && (
        <div className="space-y-5 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setParam('paused', !p.paused)}
              className="rounded-md bg-sky-500/90 px-2 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            >
              {p.paused ? 'Play' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={onReset}
              className="rounded-md bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            >
              Scatter
            </button>
            <button
              type="button"
              onClick={onNewMap}
              className="rounded-md bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            >
              New map
            </button>
            <button
              type="button"
              onClick={onDefaults}
              className="rounded-md bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            >
              Defaults
            </button>
          </div>

          {stats.selected?.speed != null && (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5 font-mono text-[11px] text-amber-200">
              <div>
                boid #{stats.selected.index} · {stats.selected.color}
              </div>
              <div>speed {stats.selected.speed.toFixed(1)} px/s</div>
              <div>steering {stats.selected.steering.toFixed(1)} px/s²</div>
              <div>neighbours {stats.selected.neighbors}</div>
            </div>
          )}

          <Slider label="Sim speed" value={p.simSpeed} min={1} max={30} step={1} onChange={(v) => setParam('simSpeed', v)} unit="×" />
          {p.showInsects && stats.insectPace < 0.95 && (
            <Hint>
              The insects can only keep up with about {Math.max(1, p.simSpeed * stats.insectPace).toFixed(0)}× here (they run on one CPU core of their own): they live slower than the fish, but every step is still a full one, so evolution is the same, only slower. For fast training use <code>npm run train</code> (headless, hundreds of times real time).
            </Hint>
          )}

          <SelectedMidge midge={stats.midges?.selected} />
          <SelectedDragonfly dragonfly={stats.dragonflies?.selected} />

          <nav className="flex flex-wrap gap-1 rounded-md bg-slate-800/80 p-0.5">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-auto rounded px-1.5 py-1 text-[11px] transition-colors ${
                  tab === t ? 'bg-sky-500/90 text-white' : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                {t}
              </button>
            ))}
          </nav>

          {tab === 'Fish' && (
            <>
              <Section title="Population">
                <LogSlider label="Count" value={p.count} min={10} max={MAX_BOIDS} zero onChange={(v) => setParam('count', v)} />
              </Section>
              <Section title="Behaviour">
                <Slider label="Alignment" value={p.alignWeight} min={0} max={3} step={0.05} onChange={(v) => setParam('alignWeight', v)} />
                <Slider label="Cohesion" value={p.cohesionWeight} min={0} max={3} step={0.05} onChange={(v) => setParam('cohesionWeight', v)} />
                <Slider label="Separation" value={p.separationWeight} min={0} max={4} step={0.05} onChange={(v) => setParam('separationWeight', v)} />
                <Slider label="Shore avoidance" value={p.wallWeight} min={0} max={8} step={0.1} onChange={(v) => setParam('wallWeight', v)} />
              </Section>
              <Section title="Senses">
                <Slider label="Vision range" value={p.perception} min={10} max={150} onChange={(v) => setParam('perception', v)} unit=" px" />
                <Slider label="Field of view" value={p.fov} min={30} max={360} step={5} onChange={(v) => setParam('fov', v)} unit="°" />
                <Slider label="Personal space" value={p.separation} min={2} max={80} onChange={(v) => setParam('separation', v)} unit=" px" />
                <Hint>Neighbours, the shore and trunks are all seen within the vision cone.</Hint>
              </Section>
              <Section title="Speed">
                <Slider label="Min speed" value={p.minSpeed} min={0} max={200} onChange={(v) => setParam('minSpeed', Math.min(v, p.maxSpeed))} unit=" px/s" />
                <Slider label="Max speed" value={p.maxSpeed} min={10} max={400} onChange={(v) => setParam('maxSpeed', Math.max(v, p.minSpeed))} unit=" px/s" />
              </Section>
              <Section title="Look">
                <Slider label="Size" value={p.boidSize} min={1} max={10} step={0.5} onChange={(v) => setParam('boidSize', v)} />
                <Slider label="Tail swing" value={p.swimWiggle} min={0} max={0.6} step={0.01} onChange={(v) => setParam('swimWiggle', v)} />
                <Slider label="Tail beat" value={p.swimBeat} min={0} max={3} step={0.05} onChange={(v) => setParam('swimBeat', v)} unit="×" />
              </Section>
              <Section title="Depth cues" fold>
                <Slider label="Deep fish fade and blur" value={p.deepFade} min={0} max={1} step={0.01} onChange={(v) => setParam('deepFade', v)} />
                <Hint>Shallow fish cast a soft shadow on the floor, as dark as the plants' (Sky → Shadow darkness).</Hint>
              </Section>
              <Section title="Steering limits" fold>
                <Slider label="Max force" value={p.maxForce} min={10} max={1000} step={10} onChange={(v) => setParam('maxForce', v)} />
                <Slider label="Max neighbours" value={p.maxNeighbors} min={4} max={128} onChange={(v) => setParam('maxNeighbors', v)} />
              </Section>
            </>
          )}

          {tab === 'Midges' && <MidgeTab params={p} setParam={setParam} stats={stats} actions={midgeActions} />}
          {tab === 'Dragonflies' && <DragonflyTab params={p} setParam={setParam} stats={stats} actions={dragonflyActions} />}

          {tab === 'Pond' && (
            <>
              <Section title="Plants">
                <Toggle label="Show plants, scum and pads" checked={p.showPlants} onChange={(v) => setParam('showPlants', v)} />
                <Dial
                  label="Planted shallows"
                  value={p.plantShallowDensity}
                  onChange={(v) => setParam('plantShallowDensity', v)}
                  range={[0, 1]}
                  step={0.01}
                  unit=""
                  knob="fill-lime-300 stroke-lime-100"
                  hand="stroke-lime-300/60"
                />
                <Dial
                  label="Sparser in deep water"
                  value={p.plantDeepSparseness}
                  onChange={(v) => setParam('plantDeepSparseness', v)}
                  range={[0, 1]}
                  step={0.01}
                  unit=""
                  knob="fill-lime-300 stroke-lime-100"
                  hand="stroke-lime-300/60"
                />
                <Slider label="Lean in the breeze" value={p.plantBreeze} min={0} max={4} step={0.1} onChange={(v) => setParam('plantBreeze', v)} />
                <Slider label="Pushed by fish" value={p.plantBend} min={0} max={4} step={0.1} onChange={(v) => setParam('plantBend', v)} />
              </Section>
              <Section title="Fallen trunks">
                <Dial
                  label="Trunks"
                  value={p.logCount}
                  onChange={(v) => setParam('logCount', v)}
                  range={[0, 10]}
                  unit=""
                  knob="fill-stone-300 stroke-stone-100"
                  hand="stroke-stone-300/60"
                />
                <button
                  type="button"
                  onClick={onShuffleLogs}
                  className="w-full rounded-md bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                >
                  Randomize trunks
                </button>
                <Slider label="Plants cleared on land" value={p.logLandClearing} min={0} max={1} step={0.05} onChange={(v) => setParam('logLandClearing', v)} />
              </Section>
              <Section title="Floor sludge">
                <Slider label="Cover" value={p.sludgeAmount} min={0} max={1} step={0.01} onChange={(v) => setParam('sludgeAmount', v)} />
                <Hint>Patches of rotting weed on the shallow to middle floor, fading into the murk.</Hint>
              </Section>
              <Section title="Floor details">
                <Slider label="Leaf litter" value={p.floorLitter} min={0} max={1} step={0.01} onChange={(v) => setParam('floorLitter', v)} />
                <Slider label="Pebbles" value={p.floorStones} min={0} max={1} step={0.01} onChange={(v) => setParam('floorStones', v)} />
                <Slider label="Sunken twigs" value={p.floorTwigs} min={0} max={1} step={0.01} onChange={(v) => setParam('floorTwigs', v)} />
                <Hint>Fallen leaves (thickest near the banks), pebble beds in the shallows, and waterlogged twigs, all fading into the murk with depth. Drawn once into the cached floor, so they cost nothing per frame (0 = none).</Hint>
              </Section>
              <Section title="Pond scum">
                <Slider label="Pushed by fish" value={p.scumDrag} min={0} max={40} step={0.5} onChange={(v) => setParam('scumDrag', v)} />
                <Slider label="Gaps close" value={p.scumCohesion} min={0} max={3} step={0.05} onChange={(v) => setParam('scumCohesion', v)} />
              </Section>
              <Section title="Fish wakes" fold>
                <Slider label="Radius" value={p.wakeRadius} min={4} max={48} onChange={(v) => setParam('wakeRadius', v)} unit=" px" />
                <Slider label="Strength" value={p.wakeStrength} min={0} max={40} step={0.5} onChange={(v) => setParam('wakeStrength', v)} />
                <Slider label="Settle rate" value={p.wakeFade} min={0.5} max={10} step={0.1} onChange={(v) => setParam('wakeFade', v)} unit=" /s" />
                <Hint>How far and how hard swimming fish push plants, pads and scum.</Hint>
              </Section>
            </>
          )}

          {tab === 'Water' && (
            <>
              <Section title="Murk">
                <Slider label="Near the surface" value={p.murkSurface} min={0} max={1} step={0.01} onChange={(v) => setParam('murkSurface', v)} />
                <Slider label="On the bottom" value={p.murkDeep} min={0} max={1} step={0.01} onChange={(v) => setParam('murkDeep', v)} />
                <Slider label="On sunken trunks" value={p.logMurk} min={0.5} max={5} step={0.1} onChange={(v) => setParam('logMurk', v)} unit="×" />
              </Section>
              <Section title="Silt">
                <Slider label="Stirred up by fish" value={p.siltAmount} min={0} max={3} step={0.05} onChange={(v) => setParam('siltAmount', v)} />
                <Slider label="Settles in" value={p.siltSettle} min={0.5} max={10} step={0.1} onChange={(v) => setParam('siltSettle', v)} unit=" s" />
                <Slider label="Opacity" value={p.siltOpacity} min={0} max={1} step={0.01} onChange={(v) => setParam('siltOpacity', v)} />
              </Section>
              <Section title="Movement">
                <Toggle label="Swirl, caustics and ripples" checked={p.showWaterMotion} onChange={(v) => setParam('showWaterMotion', v)} />
              </Section>
              <Section title="Deep swirl" fold>
                <Slider label="Strength" value={p.swirlStrength} min={0} max={0.5} step={0.01} onChange={(v) => setParam('swirlStrength', v)} />
                <Slider label="Size" value={p.swirlSize} min={200} max={3000} step={50} onChange={(v) => setParam('swirlSize', v)} unit=" px" />
                <Slider label="Speed" value={p.swirlSpeed} min={0} max={0.06} step={0.001} onChange={(v) => setParam('swirlSpeed', v)} />
              </Section>
              <Section title="Caustics" fold>
                <Slider label="Strength" value={p.causticStrength} min={0} max={0.12} step={0.005} onChange={(v) => setParam('causticStrength', v)} />
                <Slider label="Depth reach" value={p.causticDepth} min={0.1} max={1} step={0.01} onChange={(v) => setParam('causticDepth', v)} />
                <Slider label="Size" value={p.causticSize} min={60} max={600} step={10} onChange={(v) => setParam('causticSize', v)} unit=" px" />
                <Slider label="Speed" value={p.causticSpeed} min={0} max={0.1} step={0.005} onChange={(v) => setParam('causticSpeed', v)} />
              </Section>
              <Section title="Ripples" fold>
                <Slider label="Glint strength" value={p.rippleStrength} min={0} max={0.6} step={0.01} onChange={(v) => setParam('rippleStrength', v)} />
                <Slider label="Wavelength" value={p.rippleWavelength} min={3} max={20} step={0.5} onChange={(v) => setParam('rippleWavelength', v)} unit=" px" />
                <Slider label="Speed" value={p.rippleSpeed} min={0} max={15} step={0.5} onChange={(v) => setParam('rippleSpeed', v)} />
                <Slider label="Refraction" value={p.refraction} min={0} max={4} step={0.1} onChange={(v) => setParam('refraction', v)} unit=" px" />
              </Section>
            </>
          )}

          {tab === 'Sky' && (
            <>
              <Section title="Sun">
                <Dial label="Sun direction" value={p.sunAzimuth} onChange={(v) => setParam('sunAzimuth', v)} />
                <Slider label="Sun height" value={p.sunElevation} min={10} max={80} onChange={(v) => setParam('sunElevation', v)} unit="°" />
                <Slider label="Shadow darkness" value={p.shadowDarkness} min={0} max={0.9} step={0.01} onChange={(v) => setParam('shadowDarkness', v)} />
              </Section>
              <Section title="Wind and clouds">
                <Dial
                  label="Wind direction"
                  value={p.windDirection}
                  onChange={(v) => setParam('windDirection', v)}
                  knob="fill-sky-300 stroke-sky-100"
                  hand="stroke-sky-300/60"
                />
                <Dial
                  label="Wind speed"
                  value={p.cloudSpeed}
                  onChange={(v) => setParam('cloudSpeed', v)}
                  range={[0, 80]}
                  unit=" px/s"
                  knob="fill-sky-300 stroke-sky-100"
                  hand="stroke-sky-300/60"
                />
                <Toggle label="Clouds" checked={p.showClouds} onChange={(v) => setParam('showClouds', v)} />
                <Slider label="Cloud cover" value={p.cloudCover} min={0} max={1} step={0.01} onChange={(v) => setParam('cloudCover', v)} />
              </Section>
              <Section title="Cloud shape" fold>
                <Slider label="Size" value={p.cloudSize} min={300} max={4000} step={50} onChange={(v) => setParam('cloudSize', v)} unit=" px" />
                <Slider label="Edge softness" value={p.cloudSoftness} min={0.01} max={0.3} step={0.01} onChange={(v) => setParam('cloudSoftness', v)} />
                <Slider label="Darkness" value={p.cloudDarkness} min={0} max={0.7} step={0.01} onChange={(v) => setParam('cloudDarkness', v)} />
              </Section>
              <Section title="Shadow details" fold>
                <Slider label="Plant self-shadow" value={p.plantSelfShadow} min={0} max={0.6} step={0.01} onChange={(v) => setParam('plantSelfShadow', v)} />
                <Slider label="Scum and pad height" value={p.floatHeight} min={0} max={16} step={0.5} onChange={(v) => setParam('floatHeight', v)} unit=" px" />
              </Section>
            </>
          )}

          {tab === 'View' && (
            <>
              <Section title="Overlays">
                <div className="space-y-1">
                  <span className="text-xs text-slate-300">Vision range</span>
                  <Segmented
                    value={p.visionMode}
                    onChange={(v) => setParam('visionMode', v)}
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'selected', label: 'Selected' },
                      { value: 'off', label: 'Off' },
                    ]}
                  />
                </div>
                <Toggle label="Insect motion trails" checked={p.insectTrails} onChange={(v) => setParam('insectTrails', v)} />
                <Toggle label="Velocity vector" checked={p.showVelocity} onChange={(v) => setParam('showVelocity', v)} swatch="bg-gradient-to-r from-sky-400 to-amber-400" />
                <Toggle label="Steering vector" checked={p.showSteering} onChange={(v) => setParam('showSteering', v)} swatch="bg-gradient-to-r from-purple-500 to-pink-500" />
              </Section>
              <Section title="Arrow scales" fold>
                <Slider label="Velocity" value={p.velocityScale} min={0.02} max={1} step={0.01} onChange={(v) => setParam('velocityScale', v)} />
                <Slider label="Steering" value={p.steeringScale} min={0.01} max={0.5} step={0.01} onChange={(v) => setParam('steeringScale', v)} />
              </Section>
              <Section title="Lo-fi">
                <Slider label="Pixel size" value={p.pixelSize} min={1} max={8} step={0.25} onChange={(v) => setParam('pixelSize', v)} unit=" px" />
                <Slider label="Colour levels" value={p.colorLevels} min={4} max={64} onChange={(v) => setParam('colorLevels', v)} />
                <Toggle label="Dithering" checked={p.dithering} onChange={(v) => setParam('dithering', v)} />
                <Slider label="Vignette" value={p.vignette} min={0} max={1.5} step={0.05} onChange={(v) => setParam('vignette', v)} />
              </Section>
            </>
          )}

          <p className="text-[11px] leading-relaxed text-slate-500">
            Click a boid to inspect it. Arrow length = magnitude, colour shifts from cool to warm as it nears the max.
          </p>
        </div>
      )}
    </aside>
  )
}
