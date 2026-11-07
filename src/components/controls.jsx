/** Shared panel controls. */

/** A group of controls; `fold` ones (fine-tuning) start collapsed. */
export function Section({ title, fold = false, children }) {
  if (fold) {
    return (
      <details className="group space-y-2.5">
        <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span>
          {title}
        </summary>
        <div className="space-y-2.5 pt-2.5">{children}</div>
      </details>
    )
  }
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {children}
    </section>
  )
}

/** Small explanatory line under a group. */
export function Hint({ children }) {
  return <p className="text-[10px] leading-snug text-slate-500">{children}</p>
}

export function Slider({ label, value, min, max, step = 1, onChange, unit = '' }) {
  const decimals = step < 1 ? (String(step).split('.')[1]?.length ?? 0) : 0
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono tabular-nums text-slate-400">
          {value.toFixed(decimals)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-auto accent-sky-400"
      />
    </label>
  )
}

/**
 * A range on one track, [low, high]: two handles that cannot cross (the
 * low one stays at or below the high one).
 */
export function RangeSlider({ label, value: [lo, hi], min, max, step = 1, onChange, unit = '' }) {
  const decimals = step < 1 ? (String(step).split('.')[1]?.length ?? 0) : 0
  const pct = (v) => `${((v - min) / (max - min)) * 100}%`
  const thumb =
    'pointer-events-none absolute inset-0 h-1.5 w-full appearance-none bg-transparent ' +
    '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-900 [&::-webkit-slider-thumb]:bg-sky-400 ' +
    '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-slate-900 [&::-moz-range-thumb]:bg-sky-400'
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono tabular-nums text-slate-400">
          {lo.toFixed(decimals)} – {hi.toFixed(decimals)}
          {unit}
        </span>
      </div>
      <div className="relative h-1.5">
        <div className="absolute inset-0 rounded-full bg-slate-700" />
        <div className="absolute inset-y-0 rounded-full bg-sky-400" style={{ left: pct(lo), right: `calc(100% - ${pct(hi)})` }} />
        <input type="range" aria-label={`${label}: low`} min={min} max={max} step={step} value={lo} onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])} className={thumb} />
        <input type="range" aria-label={`${label}: high`} min={min} max={max} step={step} value={hi} onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])} className={thumb} />
      </div>
    </div>
  )
}

/**
 * Slider on a log scale, for ranges spanning several orders of magnitude.
 * With `zero`, the far left end is 0 (and `min` starts just after it); with
 * `unlimited`, the far right end is Infinity (shown as ∞, `max` just before it).
 */
export function LogSlider({ label, value, min, max, onChange, zero = false, unlimited = false }) {
  const lmin = Math.log(min)
  const lmax = Math.log(max)
  const off = zero ? 20 : 0 // slider steps given to the zero stop
  const top = unlimited ? 980 : 1000 // ... and to the unlimited stop
  const pos =
    zero && value <= 0 ? 0 : unlimited && !Number.isFinite(value) ? 1000 : off + ((Math.log(value) - lmin) / (lmax - lmin)) * (top - off)
  const toValue = (t) => {
    if (zero && t < off) return 0
    if (unlimited && t > top) return Infinity
    t = ((t - off) / (top - off)) * 1000
    const v = Math.exp(lmin + (t / 1000) * (lmax - lmin))
    // Round to 2 significant digits so values stay readable.
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1)
    return Math.min(max, Math.max(min, Math.round(v / mag) * mag))
  }
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono tabular-nums text-slate-400">{Number.isFinite(value) ? value.toLocaleString() : '∞ (no limit)'}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1000}
        value={pos}
        onChange={(e) => onChange(toValue(Number(e.target.value)))}
        className="h-1.5 w-full cursor-pointer appearance-auto accent-sky-400"
      />
    </label>
  )
}

export function Toggle({ label, checked, onChange, swatch }) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-xs text-slate-300">
      <span className="flex items-center gap-2">
        {swatch && <span className={`h-0.5 w-4 rounded ${swatch}`} />}
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-sky-400"
      />
    </label>
  )
}

/** One of a few options, as a row of buttons. */
export function Segmented({ value, options, onChange }) {
  return (
    <div className="grid gap-1 rounded-md bg-slate-800/80 p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
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

/** A species' range rings: every one, only the selected one, or none (the same control on each species' tab). */
export function RangeModes({ label = 'Vision range', value, onChange }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-slate-300">{label}</span>
      <Segmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'all', label: 'All' },
          { value: 'selected', label: 'Selected' },
          { value: 'off', label: 'Off' },
        ]}
      />
    </div>
  )
}

/** A grid of labelled numbers: [label, value, tone?] (tone: a text colour class). */
export function StatGrid({ items }) {
  return (
    <dl className="grid grid-cols-3 gap-1">
      {items.map(([label, value, tone]) => (
        <div key={label} className="rounded-md bg-slate-800/60 px-2 py-1">
          <dt className="truncate text-[10px] text-slate-500">{label}</dt>
          <dd className={`font-mono text-xs tabular-nums ${tone ?? 'text-slate-200'}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A species' tick rate: steps between looks around (the same control on each species' tab). */
export function TickRate({ value, onChange, children, fold = false }) {
  return (
    <Section title="Tick rate (performance)" fold={fold}>
      <Slider label="Looks around every" value={value} min={1} max={12} onChange={onChange} unit={value === 1 ? ' step' : ' steps'} />
      <Hint>
        {children} They take turns, so each step only a share of them looks; the rest steer by what they saw last. At sim speeds of {value}× and up they all look on the same step instead (each still every {value} steps), which costs far less. Slower ticks cost less and react later.
      </Hint>
    </Section>
  )
}
