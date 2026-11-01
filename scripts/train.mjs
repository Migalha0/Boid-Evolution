#!/usr/bin/env node
/**
 * Train midges and dragonflies headless: runs the same simulation as the app
 * (no rendering, no fish) far faster than real time, on a fresh map every so
 * often so the winners don't just fit one pond, and writes each species'
 * mean genome as a profile the app can import (midges in the Midges tab,
 * dragonflies in the Dragonflies tab).
 *
 *   npm run train -- --minutes 120 --maps 6 --out profiles/run1.json
 *       -> profiles/run1.json (midges) and profiles/run1-dragonflies.json
 *   npm run train -- --from profiles/run1.json --dragon-from profiles/run1-dragonflies.json   (continue)
 *   npm run train -- showDragonflies=0                       (midges alone, no predators)
 *   npm run train -- insectHunger=0.02 flowerRegrow=150      (other world params)
 *
 * Differences from the app: there is no scum (it is grown on the GPU) and no
 * shade map (everything is in the sun), so the scum and shade genes are only
 * shaped in the app itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_PARAMS } from '../src/config/defaults.js'
import { DRAGON_GENES, Dragonflies } from '../src/sim/Dragonflies.js'
import { InfluenceField } from '../src/sim/InfluenceField.js'
import { GENES, Insects } from '../src/sim/Insects.js'
import { LilyPads } from '../src/sim/LilyPads.js'
import { PondMap } from '../src/sim/PondMap.js'
import { makeProfile, parseProfile } from '../src/sim/profiles.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const k = args.indexOf(`--${name}`)
  return k >= 0 ? args[k + 1] : fallback
}
const minutes = Number(opt('minutes', 60))
const maps = Math.max(1, Number(opt('maps', 4)))
const [width, height] = opt('size', '1920x1080').split('x').map(Number)
const out = opt('out', `profiles/midges-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`)
const dragonOut = opt('dragon-out', out.replace(/(\.json)?$/, '-dragonflies.json'))
const name = opt('name', out.split('/').pop().replace(/\.json$/, ''))

const params = { ...DEFAULT_PARAMS }
for (const a of args) {
  const m = /^(\w+)=(.+)$/.exec(a)
  if (m) params[m[1]] = Number(m[2])
}
const from = opt('from', null)
const dragonFrom = opt('dragon-from', null)
const midgeStart = from ? parseProfile('midge', readFileSync(from, 'utf8')) : null
const dragonStart = dragonFrom ? parseProfile('dragonfly', readFileSync(dragonFrom, 'utf8')) : null
const hunted = Boolean(params.showDragonflies)

const map = new PondMap(new InfluenceField(8))
map.sparseness = params.plantDeepSparseness
map.shallowDensity = params.plantShallowDensity
map.logCount = params.logCount
map.landClearing = params.logLandClearing
map.layout(width + 96, height + 96)
const pads = new LilyPads(map)
pads.sync()
const insects = new Insects(map, pads)
const dragonflies = new Dragonflies(insects)
insects.predators = hunted ? dragonflies : null

const dt = 1 / 30
const total = minutes * 60
const perMap = total / maps
let nextMap = perMap
let nextReport = 0
const t0 = Date.now()
const short = ['speed', 'range', 'hungry', 'brood']
// Nothing spawns by itself: a flock of each (random, or from the starting profiles).
insects.update(dt, params)
insects.seed(params, midgeStart)
if (hunted) dragonflies.restart(params, dragonStart)
for (let t = dt; t < total; t += dt) {
  if (t >= nextMap) {
    nextMap += perMap
    map.newMap()
    pads.sync()
  }
  insects.update(dt, params)
  if (hunted) dragonflies.update(dt, params)
  if (t >= nextReport) {
    nextReport += 60
    const pop = insects.population()
    const genes = pop ? short.map((k) => `${k}=${pop.genes[k].toFixed(2)}`).join(' ') : ''
    const df = dragonflies.population()
    const dfText = hunted ? `  | dragonflies ${String(dragonflies.alive).padStart(3)} +${dragonflies.clutches} clutches${df ? ` speed=${df.genes.speed.toFixed(0)} gen ${df.generation.toFixed(1)}` : ''}` : ''
    console.log(
      `${(t / 60).toFixed(0).padStart(4)} min  midges ${String(insects.alive).padStart(4)}  gen ${pop ? pop.generation.toFixed(1) : '-'}  died out ${insects.extinctions}  old/starved/eaten ${insects.deaths.aged}/${insects.deaths.starved}/${insects.deaths.eaten}  ${genes}${dfText}`,
    )
  }
}

const save = (file, profile, genes) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(profile, null, 2))
  console.log(`\nSaved ${profile.species} profile ${file}`)
  for (const g of genes) console.log(`  ${g.label.padEnd(16)} ${profile.genes[g.key].toFixed(3).padStart(8)}  ± ${profile.spread[g.key].toFixed(3)}`)
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s for ${minutes} sim minutes.`)
save(out, makeProfile('midge', name, insects.population(), params, insects.time, insects.extinctions), GENES)
const dfPop = dragonflies.population()
if (hunted && dfPop) save(dragonOut, makeProfile('dragonfly', `${name}-dragonflies`, dfPop, params, dragonflies.time, dragonflies.extinctions), DRAGON_GENES)
else if (hunted) console.log('\nNo dragonflies alive at the end: no dragonfly profile written.')
