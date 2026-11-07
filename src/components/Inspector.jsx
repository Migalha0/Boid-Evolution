import { useLayoutEffect, useRef } from 'react'
import { MIDGE_SENSES, wiresOf } from '../species/midges.js'
import { FISH_SENSES } from '../species/fish.js'
import { ForceLegend, Vectors } from './evolution.jsx'
import { BrainFacts, ColourGene, GENES, LinkWeights, WiringDiagram } from './MidgePanel.jsx'

const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2))

/** What it is doing, as a coloured tag. */
const DOING = {
  flying: 'bg-sky-400/15 text-sky-300',
  down: 'bg-slate-400/15 text-slate-300',
  eating: 'bg-lime-400/15 text-lime-300',
  dead: 'bg-rose-400/15 text-rose-300',
}

/** A 0..1 reading as a bar, with its value. */
function Meter({ label, value, colour, text }) {
  const v = Math.min(1, Math.max(0, value ?? 0))
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono tabular-nums text-slate-200">{text ?? `${Math.round(v * 100)}%`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${v * 100}%` }} />
      </div>
    </div>
  )
}

/** A label and value in the stats grid. */
function Stat({ label, children }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="font-mono text-sm tabular-nums text-slate-100">{children}</div>
    </div>
  )
}

function Block({ title, children, open = true }) {
  return (
    <details open={open} className="group border-t border-slate-700/60 pt-2.5">
      <summary className="mb-2 cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200">
        <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span>
        {title}
      </summary>
      {children}
    </details>
  )
}

/** Energy per s, to a readable precision. */
const rate = (v) => `${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}/s`

/** How long energy lasts at a rate, in words. */
function lasts(energy, perSecond) {
  if (perSecond <= 0) return 'indefinitely'
  const s = energy / perSecond
  return s < 90 ? `${s.toFixed(0)} s` : `${(s / 60).toFixed(1)} min`
}

/** One part of the metabolism: a bar of what it burns now. */
function Burn({ label, note, now, scale, colour }) {
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-300">
          {label} <span className="text-[11px] text-slate-500">{note}</span>
        </span>
        <span className="font-mono tabular-nums text-slate-100">{rate(now)}</span>
      </div>
      <div className="relative h-2.5 rounded bg-slate-800">
        <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, (now / scale) * 100)}%` }}>
          <div className={`h-full rounded ${colour}`} />
        </div>
      </div>
    </div>
  )
}

/**
 * A midge's metabolism (species/midges.js), in three parts on one scale: its
 * base (its body, always), what flight adds (more the faster; nothing down)
 * and its neural burn (its wiring, always; each link dearer than the one
 * before).
 */
function Metabolism({ sig, doing, energy, linkCost, linkGrowth }) {
  const total = sig.baseRate + sig.flightRate + sig.neuralRate
  const scale = Math.max(sig.baseRate, sig.flightRate, sig.neuralRate, 1e-6) * 1.1
  const next = linkCost != null ? linkCost * (1 + (linkGrowth ?? 0)) ** sig.links : null
  return (
    <div className="space-y-2.5">
      <Burn label="Base" note="(always)" now={sig.baseRate} scale={scale} colour="bg-lime-400" />
      <Burn label="Flying" note={`(${doing === 'flying' ? 'grows with speed²' : 'none: down'})`} now={sig.flightRate} scale={scale} colour="bg-sky-400" />
      <Burn label="Neural" note={`(${sig.links.toFixed(0)} links${next != null ? `; one more: +${rate(next)}` : ''})`} now={sig.neuralRate} scale={scale} colour="bg-violet-400" />
      <div className="flex justify-between border-t border-slate-700/60 pt-1.5 text-xs">
        <span className="text-slate-300">Total</span>
        <span className="font-mono tabular-nums text-slate-100">{rate(total)}</span>
      </div>
      <p className="text-[11px] text-slate-500">At this rate its energy lasts {lasts(energy, total)}.</p>
    </div>
  )
}

function Midge({ midge, linkCost, linkGrowth, params }) {
  const sig = midge.senses?.signals
  const has = wiresOf(midge.genes)
  return (
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Meter label="Energy" value={midge.energy} colour="bg-lime-400" text={`${(midge.energy * midge.energyMax).toFixed(2)} / ${midge.energyMax} e · ${Math.round(midge.energy * 100)}%`} />
        <Meter label="Age" value={midge.lifespan ? midge.age / midge.lifespan : 0} colour={midge.age > midge.lifespan ? 'bg-rose-400' : 'bg-slate-400'} text={`${midge.age.toFixed(0)} / ${midge.lifespan.toFixed(0)} s`} />
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        <Stat label="Generation">{midge.generation ?? 0}</Stat>
        <Stat label="Speed">{midge.speed.toFixed(0)} px/s</Stat>
        <Stat label="Height">{(midge.position?.[2] ?? 0).toFixed(1)} px</Stat>
        <Stat label="Sees">{Math.max(0, midge.genes.vision).toFixed(0)} px</Stat>
        <Stat label="Eat">{sig ? `${sig.eat >= 0 ? '+' : ''}${sig.eat.toFixed(2)}` : '…'}</Stat>
        <Stat label="Lay">{sig ? `${sig.lay >= 0 ? '+' : ''}${sig.lay.toFixed(2)}` : '…'}</Stat>
        <Stat label="Steering">{sig ? `${sig.steer.toFixed(0)} px/s²` : '…'}</Stat>
      </div>
      <Vectors position={midge.position} velocity={midge.velocity} className="text-xs" />

      <Block title="Metabolism">{sig ? <Metabolism sig={sig} doing={midge.doing} energy={midge.energy * midge.energyMax} linkCost={linkCost} linkGrowth={linkGrowth} /> : <p className="text-xs text-slate-500">Reading…</p>}</Block>

      <Block title="Wiring (live)">
        {sig ? (
          <>
            <WiringDiagram genes={midge.genes} link={(b) => (has(b) ? 1 : 0)} senses={midge.senses} />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              Only its own links are drawn, each carrying what it adds to its output now (hover a line for its weights, one per element of its input): green positive, red negative, brighter stronger. Steering is the push on its flight in px/s² (directions push it their way; numbers up or down). Eat and lay pass through their neuron (shown under each: its type, and live its memory m) and are on above 0 (the larger wins): it comes straight down and stays down while one is on. Below, dashed, what acts on its flight besides, the same for every midge (hover one for what it does); wind drift is not in its steering total.
            </p>
            <BrainFacts params={params} genes={midge.genes} />
          </>
        ) : (
          <p className="text-xs text-slate-500">Reading its wiring…</p>
        )}
      </Block>

      <Block title="Link weights" open={false}>
        <LinkWeights genes={midge.genes} has={has} />
      </Block>

      <Block title="Forces">
        <div className="text-xs text-amber-200">
          <ForceLegend senses={midge.senses} list={MIDGE_SENSES} />
        </div>
      </Block>

      <Block title="Genes" open={false}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {GENES.map((g) => (
            <div key={g.key} className="flex justify-between gap-2 text-xs" title={g.hint}>
              <span className="truncate text-slate-400">{g.label}</span>
              <span className="font-mono tabular-nums text-slate-100">{fmt(midge.genes[g.key])}</span>
            </div>
          ))}
          <div className="col-span-2 flex justify-between gap-2 text-xs" title="its colour gene: “coloured things” sees only flower heads near this colour (it mutates; a fresh flock starts at iris yellow)">
            <span className="truncate text-slate-400">Colour gene</span>
            <span className="text-slate-100">
              <ColourGene genes={midge.genes} />
            </span>
          </div>
        </div>
      </Block>
    </>
  )
}

function Fish({ fish }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        <Stat label="Speed">{fish.speed.toFixed(1)} px/s</Stat>
        <Stat label="Steering">{fish.steering.toFixed(1)} px/s²</Stat>
        <Stat label="Neighbours">{fish.neighbors}</Stat>
        <Stat label="Depth">{(-(fish.position?.[2] ?? 0)).toFixed(1)} px</Stat>
      </div>
      <Vectors position={fish.position} velocity={fish.velocity} className="text-xs" />
      <Block title="Forces">
        <div className="text-xs text-amber-200">
          <ForceLegend senses={fish.senses} list={FISH_SENSES} />
        </div>
      </Block>
    </>
  )
}

/**
 * The selected creature, in a panel of its own at the top left (apart from
 * the world's panel): what it is doing, its readings, its wiring live (a
 * midge), its forces and genes. Shown while one is selected; closing it (or
 * Escape) deselects. `onRect` hears where it is (null: gone), for the line
 * the renderer draws from the selected one to it.
 */
export default function Inspector({ fish, midge, linkCost, linkGrowth, params, onClose, onRect }) {
  const ref = useRef(null)
  const shown = !!(fish || midge)
  useLayoutEffect(() => {
    const el = ref.current
    if (!shown || !el) {
      onRect?.(null)
      return
    }
    const report = () => onRect?.(el.getBoundingClientRect())
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      onRect?.(null)
    }
  }, [shown, onRect])
  if (!shown) return null
  const doing = midge?.doing
  return (
    <aside ref={ref} className="pointer-events-auto absolute left-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-amber-400/30 bg-slate-900/95 shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b border-slate-700/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-amber-200">{midge ? `Midge #${midge.id}` : `Fish #${fish.index}`}</h2>
          {midge && <span className={`rounded px-1.5 py-0.5 text-[11px] ${DOING[doing] ?? DOING.dead}`}>{doing}</span>}
          {fish && <span className="text-xs text-slate-400">{fish.color}</span>}
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800" title="Deselect (Escape)">
          Close
        </button>
      </header>
      <div className="space-y-3 overflow-y-auto px-4 py-3">{midge ? <Midge midge={midge} linkCost={linkCost} linkGrowth={linkGrowth} params={params} /> : <Fish fish={fish} />}</div>
    </aside>
  )
}
