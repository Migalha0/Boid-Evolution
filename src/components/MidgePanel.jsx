import { GENES } from '../sim/Insects.js'
import { PLANT_KINDS, plantAmountKey } from '../sim/Vegetation.js'
import { Hint, LogSlider, Section, Slider, Toggle } from './controls.jsx'
import { GeneTable, PopulationChart, Profiles, button } from './evolution.jsx'

/** The selected midge, for the top of the panel. */
export function SelectedMidge({ midge }) {
  if (!midge) return null
  return (
    <div className="space-y-1.5 rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5 font-mono text-[11px] text-amber-200">
      <div>
        midge #{midge.id} · generation {midge.generation} · {midge.doing}
      </div>
      <div>
        age {midge.age.toFixed(0)} / {midge.life.toFixed(0)} s · energy {(midge.energy * 100).toFixed(0)}%
      </div>
      <div>
        eggs laid {midge.laid} · hatched {midge.children}
      </div>
      <details>
        <summary className="cursor-pointer text-amber-300/70">genes</summary>
        <GeneTable genes={midge.genes} list={GENES} />
      </details>
    </div>
  )
}

/** The Midges tab. `actions`: restart(profile?), apply(profile), population(). */
export function MidgeTab({ params: p, setParam, stats, actions }) {
  const m = stats.midges
  const pop = m?.population
  // Spawning replaces whoever is there, and shows them.
  const spawnFrom = (profile) => {
    setParam('showInsects', true)
    actions.restart(profile)
  }
  const spawn = () => spawnFrom(null)
  return (
    <>
      <Section title="Midges">
        <Toggle label="Show midges" checked={p.showInsects} onChange={(v) => setParam('showInsects', v)} />
        <button type="button" className={`${button} w-full`} onClick={spawn}>
          Spawn random flock ({p.insectStart})
        </button>
        {m && !m.population && !m.eggs && !m.extinct && <Hint>No midges yet: nothing spawns by itself.</Hint>}
        {m && (
          <>
            <p className="font-mono text-[11px] tabular-nums text-slate-400">
              {m.alive} alive · {m.eggs} rafts · {m.swarms} swarms
              <br />
              generation {pop ? `${pop.generation.toFixed(1)} (max ${pop.maxGeneration})` : '–'} · {m.extinct ? 'extinct' : `died out ${m.extinctions}×`}
              <br />
              died: {m.deaths.aged} old · {m.deaths.starved} starved · {m.deaths.eaten} eaten
              <br />
              flowers: {m.dry} drunk dry · {m.resting} resting / {m.flowers} · {(m.time / 60).toFixed(1)} min
            </p>
            <PopulationChart history={m.history} title="Midges alive" />
          </>
        )}
      </Section>
      <Section title="Evolution">
        <Slider label="Mutation chance" value={p.mutationRate} min={0} max={0.5} step={0.01} onChange={(v) => setParam('mutationRate', v)} unit=" /gene" />
        <Slider label="Mutation size" value={p.mutationSize} min={0} max={0.3} step={0.01} onChange={(v) => setParam('mutationSize', v)} />
        <LogSlider label="Flock size" value={p.insectStart} min={10} max={1000} onChange={(v) => setParam('insectStart', v)} />
        <Hint>
          Every midge has its own genes. Egg rafts carry the mother&apos;s, and each hatchling mutates them a little. The ones that feed and breed best spread their genes. Spawning replaces any midges there are with a fresh flock; if they die out they stay gone until you spawn again. Raise the sim speed at the top to train (with no fish, 10–30× runs smoothly), or use <code>npm run train</code> for much faster headless training.
        </Hint>
      </Section>
      {pop && (
        <Section title="Population genes" fold>
          <GeneTable genes={pop.genes} spread={pop.spread} list={GENES} compare={p.midgeProfile?.genes} compareLabel="profile" />
          <Hint>Mean ± spread over the living midges. Shrinking spread means selection is settling on a value.</Hint>
        </Section>
      )}
      <Profiles
        species="midge"
        title="Midge profiles"
        params={p}
        setParam={setParam}
        stats={m}
        actions={{ ...actions, restart: spawnFrom }}
        profileKey="midgeProfile"
        lockKey="midgeLocked"
        plural="midges"
        restartLabel="Spawn flock from it"
      />
      <Section title="World" fold>
        <LogSlider label="Population cap" value={p.insectCount} min={10} max={5000} unlimited onChange={(v) => setParam('insectCount', v)} />
        <Slider label="Energy burnt" value={p.insectHunger} min={0.002} max={0.08} step={0.001} onChange={(v) => setParam('insectHunger', v)} unit=" /s" />
        <Slider label="Lifespan" value={p.insectLifespan} min={10} max={600} step={5} onChange={(v) => setParam('insectLifespan', v)} unit=" s" />
        <Slider label="Eggs hatch after" value={p.insectHatch} min={2} max={120} step={1} onChange={(v) => setParam('insectHatch', v)} unit=" s" />
        <Slider label="Bodies last" value={p.insectBodyTime} min={1} max={60} step={1} onChange={(v) => setParam('insectBodyTime', v)} unit=" s" />
        <Slider label="Carried by the wind" value={p.insectWind} min={0} max={2} step={0.05} onChange={(v) => setParam('insectWind', v)} />
        <Hint>
          What the midges live in, not part of their genes. Energy is burnt flying (more the faster) and refilled by drinking from flowers. Keep the cap above what the flowers can feed (or at ∞) so food, not the cap, decides who breeds.
        </Hint>
        <h4 className="pt-1 text-[11px] text-slate-400">Flowers</h4>
        <Slider label="Nectar per flower" value={p.flowerNectar} min={0.05} max={2} step={0.05} onChange={(v) => setParam('flowerNectar', v)} unit=" meals" />
        <Slider label="Flower refills in" value={p.flowerRegrow} min={5} max={300} step={5} onChange={(v) => setParam('flowerRegrow', v)} unit=" s" />
        <Slider label="Refills before resting" value={p.flowerRefills} min={0} max={20} step={0.5} onChange={(v) => setParam('flowerRefills', v)} />
        <Slider label="Flowers rest for" value={p.flowerDormancy} min={0} max={600} step={10} onChange={(v) => setParam('flowerDormancy', v)} unit=" s" />
        <Hint>Flowers fade as they are drunk and close until refilled. Each, after about that many refills (0: never), wilts and gives nothing while it rests, then refills from empty; every flower keeps its own count, so busy patches go quiet while others bloom.</Hint>
        <h4 className="pt-1 text-[11px] text-slate-400">Plants</h4>
        {PLANT_KINDS.map((k) => {
          const key = plantAmountKey(k.name)
          const label = `${k.name[0].toUpperCase()}${k.name.slice(1)}${k.name === 'iris' ? ' (yellow)' : k.name === 'pickerelweed' ? ' (purple)' : ''}`
          return <Slider key={key} label={label} value={p[key]} min={0} max={3} step={0.05} onChange={(v) => setParam(key, v)} unit="×" />
        })}
        <Hint>How much of each plant grows (the map regrows when changed). Iris and pickerelweed flowers are the midges&apos; food; the others give shade and shelter from the wind.</Hint>
      </Section>
    </>
  )
}
