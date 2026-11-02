import { useEffect, useState } from 'react'

/** How long (ms) the pointer must leave something alone before it fades: the collapsed panel, the graph tab, the cursor over the pond. */
export const IDLE_DELAY = 5000

/**
 * Whether a collapsed piece of UI has gone untouched long enough to fade
 * (`enabled`: it is collapsed; `delay` ms without the pointer on it). Returns
 * [faded, handlers]: spread the handlers on its outermost element.
 */
export function useIdleFade(enabled, delay = IDLE_DELAY) {
  const [hovered, setHovered] = useState(false)
  const [faded, setFaded] = useState(false)
  useEffect(() => {
    setFaded(false)
    if (!enabled || hovered) return
    const t = setTimeout(() => setFaded(true), delay)
    return () => clearTimeout(t)
  }, [enabled, hovered, delay])
  return [faded, { onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) }]
}

/** Faded: almost see-through, a white-ish outline so it is still there to find. */
export const FADED = 'border-white/50 bg-slate-900/10 shadow-none *:opacity-25'
export const FADE_TRANSITION = 'transition-[background-color,border-color,box-shadow] duration-700 *:transition-opacity *:duration-700'
