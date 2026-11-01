import { DRAGON_GENES } from '../sim/Dragonflies.js'
import { Hint, LogSlider, Section, Slider, Toggle } from './controls.jsx'
import { GeneTable, PopulationChart, Profiles, button } from './evolution.jsx'

/** The selected dragonfly, for the top of the panel. */
export function SelectedDragonfly({ dragonfly: d }) {
  if (!d) return null
  const [r, g, b] = d.colour.map((c) => Math.round(c * 255))
  return (
    <div className="space-y-1.5 rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5 font-mono text-[11px] text-amber-200">
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${r},${g},${b})` }} />
        dragonfly #{d.id} · generation {d.generation} · {d.doing}
      </div>
      <div>
        age {d.age.toFixed(0)} / {d.life.toFixed(0)} s · energy {(d.energy * 100).toFixed(0)}%
      </div>
      <div>
        midges eaten {d.kills} · offspring {d.children}
      </div>
      <details>
        <summary className="cursor-pointer text-amber-300/70">genes</summary>
        <GeneTable genes={d.genes} list={DRAGON_GENES} />
      </details>
    </div>
  )
}

/** The Dragonflies tab. `actions`: restart(profile?), apply(profile), population(). */
export function DragonflyTab({ params: p, setParam, stats, actions }) {
  const df = stats.dragonflies
  const pop = df?.population
  // Spawning replaces whoever is there, and shows them (and the midges they live on).
  const spawnFrom = (profile) => {
    setParam('showInsects', true)
    setParam('showDragonflies', true)
    actions.restart(profile)
  }
  return (
    <>
      <Section title="Dragonflies">
        <Toggle label="Show dragonflies" checked={p.showDragonflies} onChange={(v) => setParam('showDragonflies', v)} />
        <button type="button" className={`${button} w-full`} onClick={() => spawnFrom(null)}>
          Spawn random dragonflies ({p.dragonflyStart})
        </button>
        {df && !pop && !df.clutches && !df.extinct && <Hint>No dragonflies yet: nothing spawns by itself. They live on midges, so spawn midges first.</Hint>}
        {df && (
          <>
            <p className="font-mono text-[11px] tabular-nums text-slate-400">
              {df.alive} alive · {df.clutches} clutches · midges eaten {df.eaten}
              <br />
              generation {pop ? `${pop.generation.toFixed(1)} (max ${pop.maxGeneration})` : '–'} · {df.extinct ? 'extinct' : `died out ${df.extinctions}×`}
              <br />
              died: {df.deaths.aged} old · {df.deaths.starved} starved · {(df.time / 60).toFixed(1)} min
            </p>
            <PopulationChart history={df.history} title="Dragonflies alive" stroke="stroke-teal-400" fill="fill-teal-400" />
          </>
        )}
      </Section>
      <Section title="Evolution">
        <Slider label="Mutation chance" value={p.dragonflyMutationRate} min={0} max={0.5} step={0.01} onChange={(v) => setParam('dragonflyMutationRate', v)} unit=" /gene" />
        <Slider label="Mutation size" value={p.dragonflyMutationSize} min={0} max={0.3} step={0.01} onChange={(v) => setParam('dragonflyMutationSize', v)} />
        <Slider label="Spawn count" value={p.dragonflyStart} min={1} max={30} step={1} onChange={(v) => setParam('dragonflyStart', v)} />
        <Hint>
          Every dragonfly has its own genes, body colour included (it only drifts, so lineages show as colours). Well-fed ones lay eggs in the water among the plants, and the dragonflies that emerge carry their mother&apos;s genes, mutated. Their clutches show on the water among the plants, browning as they ripen. The best hunters spread their genes. Spawning replaces any dragonflies there are; if they die out they stay gone until you spawn again.
        </Hint>
      </Section>
      {pop && (
        <Section title="Population genes" fold>
          <GeneTable genes={pop.genes} spread={pop.spread} list={DRAGON_GENES} compare={p.dragonflyProfile?.genes} compareLabel="profile" />
          <Hint>Mean ± spread over the living dragonflies.</Hint>
        </Section>
      )}
      <Profiles
        species="dragonfly"
        title="Dragonfly profiles"
        params={p}
        setParam={setParam}
        stats={df}
        actions={{ ...actions, restart: spawnFrom }}
        profileKey="dragonflyProfile"
        lockKey="dragonflyLocked"
        plural="dragonflies"
        restartLabel="Spawn from it"
      />
      <Section title="World" fold>
        <LogSlider label="Population cap" value={p.dragonflyCap} min={1} max={1000} unlimited onChange={(v) => setParam('dragonflyCap', v)} />
        <Slider label="Energy burnt" value={p.dragonflyHunger} min={0.005} max={0.08} step={0.001} onChange={(v) => setParam('dragonflyHunger', v)} unit=" /s" />
        <Slider label="Energy per midge" value={p.dragonflyMeal} min={0.02} max={0.6} step={0.01} onChange={(v) => setParam('dragonflyMeal', v)} />
        <Slider label="Time to digest" value={p.dragonflyDigest} min={0} max={10} step={0.25} onChange={(v) => setParam('dragonflyDigest', v)} unit=" s" />
        <Slider label="Swarm confusion" value={p.swarmConfusion} min={0} max={1} step={0.01} onChange={(v) => setParam('swarmConfusion', v)} />
        <Slider label="Lifespan" value={p.dragonflyLifespan} min={30} max={900} step={10} onChange={(v) => setParam('dragonflyLifespan', v)} unit=" s" />
        <Slider label="Eggs emerge after" value={p.dragonflyHatch} min={10} max={300} step={5} onChange={(v) => setParam('dragonflyHatch', v)} unit=" s" />
        <Hint>
          Dragonflies only gain energy by eating midges (flying fast burns more), and after a catch they don&apos;t hunt again until it is digested, so their numbers rise and fall after the midges&apos;, delayed by how long eggs take to emerge. How much a midge gives and how long it takes to digest also depend on each dragonfly&apos;s gut gene. A strike misses more often among other flying midges (swarm confusion: each one near the prey divides the chance by 1 + this), which is what swarming can evolve for. Dragonflies are slower in the shade. A midge flees a hunting dragonfly at its top speed (from as far as its vigilance gene says), so fast midges get away.
        </Hint>
      </Section>
    </>
  )
}
