import { useCallback, useMemo, useRef, useState } from 'react'
import BoidCanvas from './components/BoidCanvas.jsx'
import ControlPanel from './components/ControlPanel.jsx'
import PopulationDrawer from './components/PopulationDrawer.jsx'
import { DEFAULT_PARAMS } from './config/defaults.js'
import { randomMurk, randomWorld } from './config/world.js'

export default function App() {
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [stats, setStats] = useState({ fps: 0, gpuSimMs: null, gpuRenderMs: null, frameMs: null, count: 0, selected: null })
  const canvasRef = useRef(null)

  const setParam = useCallback((key, value) => setParams((p) => ({ ...p, [key]: value })), [])

  const midgeActions = useMemo(
    () => ({
      restart: (profile) => canvasRef.current?.restartMidges(profile),
      clear: () => canvasRef.current?.clearMidges(),
      apply: (profile) => canvasRef.current?.applyMidgeProfile(profile),
      population: () => canvasRef.current?.midgePopulation() ?? null,
    }),
    [],
  )

  return (
    <main className="relative h-full w-full overflow-hidden bg-slate-950">
      <BoidCanvas ref={canvasRef} params={params} onStats={setStats} />
      <PopulationDrawer history={stats.history} />
      <ControlPanel
        params={params}
        setParam={setParam}
        stats={stats}
        onReset={() => canvasRef.current?.reset()}
        onNewMap={() => {
          canvasRef.current?.newMap()
          setParams((p) => ({ ...p, ...randomMurk() }))
        }}
        onRandomizeWorld={() => setParams((p) => ({ ...p, ...randomWorld() }))}
        onShuffleLogs={() => canvasRef.current?.shuffleLogs()}
        onDefaults={() => setParams(DEFAULT_PARAMS)}
        midgeActions={midgeActions}
      />
    </main>
  )
}
