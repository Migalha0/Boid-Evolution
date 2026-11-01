import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Engine } from '../engine/Engine.js'

const BoidCanvas = forwardRef(function BoidCanvas({ params, onStats, onSelect }, ref) {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const [error, setError] = useState(null)
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
    restartDragonflies: (profile) => engineRef.current?.restartDragonflies(profile),
    applyDragonflyProfile: (profile) => engineRef.current?.applyDragonflyProfile(profile),
    dragonflyPopulation: () => engineRef.current?.dragonflyPopulation() ?? null,
    // Exposed for the upcoming region painting tools.
    get field() {
      return engineRef.current?.field ?? null
    },
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

  const handlePointerDown = (e) => {
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
      className="block h-full w-full cursor-crosshair touch-none [image-rendering:pixelated]"
    />
  )
})

export default BoidCanvas
