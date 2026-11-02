import { PLANT_KINDS, plantAmountKey } from '../sim/Vegetation.js'

/**
 * Rerolled world conditions, as params to merge in. "New map" lays out new
 * shores and a new floor; these change what lives and happens on a map
 * (plants, depth, water, trunks, weather) and leave its shape alone. Ranges
 * stay around the defaults, so every roll still reads as a pond. The
 * creatures' own settings (their genes, food, lifespans) are not touched.
 */

const between = (a, b, digits = 2) => {
  const k = 10 ** digits
  return Math.round((a + Math.random() * (b - a)) * k) / k
}

/** The water's murk: from clearer to murkier. */
export function randomMurk() {
  return { murkSurface: between(0.05, 0.35), murkDeep: between(0.65, 0.97), logMurk: between(1.5, 4, 1) }
}

export function randomWorld() {
  return {
    // The pond: depth, plant mix and spread, trunks, floor, scum and pads.
    waterDepth: between(0.55, 1.2),
    ...Object.fromEntries(PLANT_KINDS.map((k) => [plantAmountKey(k.name), between(0.3, 1.8)])),
    plantShallowDensity: between(0.3, 0.8),
    plantDeepSparseness: between(0.3, 0.9),
    logCount: Math.floor(Math.random() * 9),
    sludgeAmount: between(0.2, 0.8),
    floorLitter: between(0.1, 0.8),
    floorStones: between(0.1, 0.7),
    floorTwigs: between(0.1, 0.6),
    scumAmount: between(0.3, 1.6),
    padAmount: between(0.3, 2),
    flowerVariation: between(0.8, 2.5),
    // The water.
    ...randomMurk(),
    waterTint: between(0, 1),
    // Weather: sun, wind (and how far it carries the midges), clouds.
    sunAzimuth: Math.floor(Math.random() * 360),
    sunElevation: Math.floor(between(20, 65, 0)),
    windDirection: Math.floor(Math.random() * 360),
    cloudSpeed: Math.floor(between(4, 40, 0)),
    insectWind: between(0.3, 1.6),
    cloudCover: between(0.1, 0.8),
  }
}
