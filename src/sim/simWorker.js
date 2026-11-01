import { Dragonflies } from './Dragonflies.js'
import { Insects } from './Insects.js'
import { LogSegment } from './Logs.js'
import { PondMap } from './PondMap.js'
import { Vegetation } from './Vegetation.js'

/**
 * The midges and dragonflies, run off the main thread so they never cost the
 * fish (and the renderer) any frame time. The same Insects / Dragonflies code
 * as the headless trainer, unchanged: only where it runs differs.
 *
 * The world they live in is mirrored from the main thread (InsectWorld sends
 * it whenever the map, plants or pads change): a PondMap stand-in with just
 * what the insects read (size, shore distance, trunks, plants) and the pads.
 * Nectar lives here (the midges drink it) and goes back with every frame.
 *
 * In: world, params, scum, shade, step, select, deselect, restartMidges,
 * restartDragonflies, applyMidges, applyDragonflies.
 * Out: frame (both point buffers, alive counts, nectar, and stats on request).
 */

const map = Object.create(PondMap.prototype)
Object.assign(map, { width: 0, height: 0, sdf: new Float32Array(1), sdfCols: 1, sdfRows: 1, logs: [], vegetation: new Vegetation() })
const pads = { count: 0, data: new Float32Array(0), version: -1 }
const insects = new Insects(map, pads)
const dragonflies = new Dragonflies(insects)
let params = null
let vegVersion = -1
let bloomSent = -1

/** Keep a profile's identity while it is unchanged (the sims tell a new profile by identity). */
function keepProfile(next, key) {
  const old = params?.[key]
  if (old && next[key] && JSON.stringify(old) === JSON.stringify(next[key])) next[key] = old
}

function setWorld(w) {
  map.width = w.width
  map.height = w.height
  map.sdf = w.sdf
  map.sdfCols = w.sdfCols
  map.sdfRows = w.sdfRows
  map.logs = w.logs.map((l) => Object.assign(Object.create(LogSegment.prototype), l))
  const veg = map.vegetation
  veg.data = w.plants
  veg.bloom = w.bloom
  veg.count = w.plantCount
  veg.version = w.plantVersion
  vegVersion = w.plantVersion
  pads.data = w.pads
  pads.count = w.padCount
  pads.version = w.padVersion
}

function step(n, dt) {
  if (!params?.showInsects) return
  const hunted = params.showDragonflies
  insects.predators = hunted ? dragonflies : null
  for (let k = 0; k < n; k++) {
    insects.update(dt, params)
    if (hunted) dragonflies.update(dt, params)
  }
}

/** Both point buffers (copies, handed over), alive counts, nectar if it changed, and stats if asked. */
function postFrame(withStats) {
  const midges = insects.data.slice()
  const dragon = dragonflies.data.slice()
  const veg = map.vegetation
  const bloom = veg.bloomVersion !== bloomSent ? veg.bloom.slice(0, veg.count) : null
  bloomSent = veg.bloomVersion
  const transfer = [midges.buffer, dragon.buffer]
  if (bloom) transfer.push(bloom.buffer)
  postMessage(
    {
      type: 'frame',
      midges: { data: midges, points: insects.points },
      dragonflies: { data: dragon, points: dragonflies.points },
      alive: [insects.alive, dragonflies.alive],
      time: insects.time,
      bloom,
      plantVersion: vegVersion,
      stats: withStats ? { midges: insects.stats(), dragonflies: dragonflies.stats() } : null,
    },
    transfer,
  )
}

onmessage = ({ data: m }) => {
  switch (m.type) {
    case 'world':
      setWorld(m.world)
      return
    case 'params':
      keepProfile(m.params, 'midgeProfile')
      keepProfile(m.params, 'dragonflyProfile')
      params = m.params
      return
    case 'scum':
      insects.setScum(m.points)
      return
    case 'shade':
      insects.setShade(m.values, m.w, m.h, m.cell, m.offset)
      return
    case 'step':
      step(m.steps, m.dt)
      postFrame(m.stats)
      return
    case 'select':
      // A dragonfly or a midge (the main thread saw which is there); the other is deselected.
      if (m.kind === 'dragonfly') {
        dragonflies.select(m.x, m.y)
        insects.select(-1e9, -1e9)
      } else {
        insects.select(m.x, m.y)
        dragonflies.select(-1e9, -1e9)
      }
      postFrame(true)
      return
    case 'deselect':
      insects.select(-1e9, -1e9)
      dragonflies.select(-1e9, -1e9)
      postFrame(true)
      return
    case 'restartMidges':
      if (!insects.capacity) insects.update(0, params)
      insects.seed(params, m.profile ?? (params.midgeLocked ? params.midgeProfile : null))
      postFrame(true)
      return
    case 'restartDragonflies':
      dragonflies.restart(params, m.profile)
      postFrame(true)
      return
    case 'applyMidges':
      insects.applyProfile(m.profile)
      postFrame(true)
      return
    case 'applyDragonflies':
      dragonflies.applyProfile(m.profile)
      postFrame(true)
  }
}
