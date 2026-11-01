import { DRAGON_GENES } from './Dragonflies.js'
import { genomeToObject, objectToGenome } from './genetics.js'
import { GENES } from './Insects.js'

/**
 * Profiles: a species' genome (the mean of a trained population) with how it
 * was made, saved as JSON. Each species has its own format, so a midge
 * profile can't be imported as a dragonfly's or the other way round. The app
 * keeps a library per species in localStorage and imports / exports them as
 * files; scripts/train.mjs writes them.
 */
export const SPECIES = {
  midge: {
    name: 'midge',
    format: 'midge-profile',
    genes: GENES,
    storageKey: 'midgeProfiles',
    tab: 'Midges',
    world: ['insectHunger', 'flowerNectar', 'flowerRegrow', 'flowerRefills', 'flowerDormancy', 'insectLifespan', 'insectHatch'],
  },
  dragonfly: {
    name: 'dragonfly',
    format: 'dragonfly-profile',
    genes: DRAGON_GENES,
    storageKey: 'dragonflyProfiles',
    tab: 'Dragonflies',
    world: ['dragonflyHunger', 'dragonflyMeal', 'dragonflyDigest', 'swarmConfusion', 'dragonflyLifespan', 'dragonflyHatch', 'dragonflyCap'],
  },
}

/** A profile of `species` from a population summary ({ count, generation, genes, spread }) and the world params it lived in. */
export function makeProfile(species, name, population, params, seconds = 0, extinctions = 0) {
  const sp = SPECIES[species]
  return {
    format: sp.format,
    version: 1,
    species,
    name,
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
export function parseProfile(species, json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json
  if (!p || typeof p !== 'object' || !p.genes || typeof p.genes !== 'object') throw new Error('Not a profile (no genes).')
  const sp = SPECIES[species]
  const format = p.format ?? SPECIES.midge.format
  const other = Object.values(SPECIES).find((s) => s.format === format && s !== sp)
  if (other) throw new Error(`This is a ${other.name} profile: import it in the ${other.tab} tab.`)
  if (format !== sp.format) throw new Error(`Not a ${sp.name} profile (format "${format}").`)
  if (!sp.genes.some((g) => Number.isFinite(Number(p.genes[g.key])))) throw new Error(`Not a ${sp.name} profile (no ${sp.name} genes).`)
  return { ...p, format: sp.format, species, name: String(p.name ?? 'imported'), genes: genomeToObject(sp.genes, objectToGenome(sp.genes, p.genes)) }
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
