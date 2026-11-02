import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Engine } from '../engine/Engine.js'
import { IDLE_DELAY } from './useIdleFade.js'

/**
 * The cursor left still over the pond: a crosshair drawn see-through (an OS
 * cursor can't be faded with CSS), white with a dark outline, hotspot in the
 * middle.
 */
const FADED_CURSOR = (() => {
  const arms = 'M12 2v7M12 15v7M2 12h7M15 12h7'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" opacity="0.35"><path d="${arms}" stroke="#000" stroke-width="3"/><path d="${arms}" stroke="#fff" stroke-width="1"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
})()

const BoidCanvas = forwardRef(function BoidCanvas({ params, onStats, onSelect }, ref) {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const [error, setError] = useState(null)
  // The cursor fades after IDLE_DELAY ms without moving over the pond.
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef(0)
  const wake = () => {
    clearTimeout(idleTimer.current)
    setIdle(false)
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_DELAY)
  }
  useEffect(() => () => clearTimeout(idleTimer.current), [])
  // Latest params for engine creation without re-creating it on every change.
  const paramsRef = useRef(params)
  paramsRef.current = params

  useImperativeHandle(ref, () => ({
    reset: () => engineRef.current?.reset(),
    newMap: () => engineRef.current?.newMap(),
    shuffleLogs: () => engineRef.current?.shuffleLogs(),
    restartMidges: (profile) => engineRef.current?.restartMidges(profile),
    applyMidgeProfile: (profile) => engineRef.current?.applyMidgeProfile(profile),
    midgePopulation: () => engineRef.current?.midgePopulation() ?? null,
    clearMidges: () => engineRef.current?.clearMidges(),
  }))

  useEffect(() => {
    let engine
    try {
      engine = new Engine(canvasRef.current, paramsRef.current, onStats)
    } catch (e) {
      setError(e.message)
      return
    }
    engineRef.current = engine
    engine.start()
    return () => {
      engine.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    engineRef.current?.setParams(params)
  }, [params])

  // Escape deselects whatever is selected.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !engineRef.current) return
      engineRef.current.deselect()
      onSelect?.(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSelect])

  const handlePointerDown = (e) => {
    wake()
    const engine = engineRef.current
    if (!engine) return
    const rect = e.currentTarget.getBoundingClientRect()
    engine.pick(e.clientX - rect.left, e.clientY - rect.top, onSelect)
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-red-300">
        {error}
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={wake}
      onPointerLeave={() => {
        clearTimeout(idleTimer.current)
        setIdle(false)
      }}
      style={idle ? { cursor: FADED_CURSOR } : undefined}
      className="block h-full w-full cursor-crosshair touch-none [image-rendering:pixelated]"
    />
  )
})

export default BoidCanvas
