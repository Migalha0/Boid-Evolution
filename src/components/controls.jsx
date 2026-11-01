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
