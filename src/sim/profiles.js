import { genomeToObject, objectToGenome } from './genetics.js'
import { MIDGE_GENES as GENES } from '../species/midges.js'
import { PLANT, PLANT_KINDS } from './Vegetation.js'

/**
 * Profiles: a species' genome with how it was made, saved as JSON. The
 * genome is either a population's average (`source: 'average'`, with the
 * spread of each gene) or one individual's exact genes (`source:
 * 'individual'`, with its id). Each species has its own format, so one
 * species' profile can't be imported as another's. The app
 * keeps a library per species in localStorage and imports / exports them as
 * files.
 */
const SPECIES = {
  midge: {
    name: 'midge',
    format: 'midge-profile',
    genes: GENES,
    storageKey: 'midgeProfiles',
    tab: 'Midges',
    world: ['insectHunger', 'insectWind', 'flowerNectar', 'flowerRegrow', 'flowerRefills', 'flowerDormancy'],
  },
}

/**
 * A profile of `species` from a population summary ({ count, generation,
 * genes, spread }) and the world params it lived in.
 */
export function makeProfile(species, name, population, params, seconds = 0, extinctions = 0) {
  const sp = SPECIES[species]
  return {
    format: sp.format,
    version: 1,
    species,
    name,
    source: 'average',
    created: new Date().toISOString(),
    generation: population ? Math.round(population.generation * 10) / 10 : 0,
    population: population?.count ?? 0,
    trainedSeconds: Math.round(seconds),
    extinctions,
    genes: population?.genes ?? {},
    spread: population?.spread ?? {},
    // The world it was trained in, for reference: these are not applied on import.
    world: Object.fromEntries(sp.world.map((k) => [k, params[k]])),
  }
}

/**
 * Check and tidy an imported profile of `species` (genes clamped to their
 * ranges); throws if it isn't one, naming the tab it belongs in if it is
 * another species'. Files from before formats were per species (no format,
 * or `midge-profile` without a species) count as midge profiles.
 */
/** A profile of one individual (a selected midge: { id, generation, genes }): its exact genes. */
export function makeIndividualProfile(species, name, individual, params, seconds = 0) {
  const zero = Object.fromEntries(Object.keys(individual.genes).map((k) => [k, 0]))
  return {
    ...makeProfile(species, name, { count: 1, generation: individual.generation, genes: individual.genes, spread: zero }, params, seconds),
    source: 'individual',
    individual: individual.id,
  }
}

export function parseProfile(species, json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json
  if (!p || typeof p !== 'object' || !p.genes || typeof p.genes !== 'object') throw new Error('Not a profile (no genes).')
  const sp = SPECIES[species]
  const format = p.format ?? SPECIES.midge.format
  const other = Object.values(SPECIES).find((s) => s.format === format && s !== sp)
  if (other) throw new Error(`This is a ${other.name} profile: import it in the ${other.tab} tab.`)
  if (format !== sp.format) throw new Error(`Not a ${sp.name} profile (format "${format}").`)
  if (!sp.genes.some((g) => Number.isFinite(Number(p.genes[g.key])))) throw new Error(`Not a ${sp.name} profile (no ${sp.name} genes).`)
  // Files from before colour genes: a pull to purple (pickerelweed) and to
  // yellow (iris) flowers. The colour of the one it liked more, as strongly.
  if (p.genes.flowerR == null && (p.genes.purple != null || p.genes.yellow != null)) {
    const purple = Number(p.genes.purple) || 0
    const yellow = Number(p.genes.yellow) || 0
    const likes = Math.abs(purple) >= Math.abs(yellow) ? purple : yellow
    const [r, g, b] = PLANT_KINDS[likes === purple ? PLANT.PICKERELWEED : PLANT.IRIS].head.color
    p.genes = { ...p.genes, flowers: likes, flowerR: r, flowerG: g, flowerB: b, colourTolerance: 0.5 }
  }
  // Files from before `source` were all population averages.
  const source = p.source === 'individual' ? 'individual' : 'average'
  return { ...p, format: sp.format, species, source, name: String(p.name ?? 'imported'), genes: genomeToObject(sp.genes, objectToGenome(sp.genes, p.genes)) }
}

export function loadLibrary(species) {
  try {
    const list = JSON.parse(localStorage.getItem(SPECIES[species].storageKey) ?? '[]')
    if (!Array.isArray(list)) return []
    return list.flatMap((p) => {
      try {
        return [parseProfile(species, p)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function saveLibrary(species, list) {
  try {
    localStorage.setItem(SPECIES[species].storageKey, JSON.stringify(list))
  } catch {
    // Storage blocked or full: the library just lasts for this session.
  }
}

/** Download a profile as a .json file (named with its species, so files are told apart). */
export function downloadProfile(profile) {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const base = profile.name.replace(/[^\w.-]+/g, '-')
  a.download = `${base.includes(profile.species) ? base : `${profile.species}-${base}`}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
