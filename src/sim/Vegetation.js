import { PX_PER_METER } from './scale.js'

/**
 * Instance layout uploaded to the GPU:
 * [x, y, scale, rotation, kind, seed, brown, yellow] where brown/yellow (0..1)
 * blend the plant towards the regional dry-brown / yellow-green palettes;
 * plants growing on land have LAND_FLAG added to yellow.
 */
export const PLANT_STRIDE = 8
export const LAND_FLAG = 2
/** The plant shader declares uniform arrays of this size. */
export const MAX_KINDS = 8

/**
 * Plant kinds, in real-life units (metres; converted with PX_PER_METER).
 * A plant is drawn top-down as a fan of tapered blades from its base, centred
 * on the plant's rotation, optionally with a head on the central blade.
 *   blades  number of blades (max 8)
 *   length  [min, max] blade length in m (before the plant's scale)
 *   width   blade width at the base in m
 *   spread  angle of the fan in radians (2π = all around)
 *   base/tip colours along the blade
 *   head    optional { length, width, color } at the tip of the central blade
 *   regional how strongly the regional colour (green / yellow-green / brown) applies
 */
const KINDS_METERS = [
  { name: 'rush', blades: 6, length: [0.12, 0.22], width: 0.025, spread: 2.2, regional: 0.75, base: [0.22, 0.33, 0.12], tip: [0.38, 0.45, 0.19] },
  { name: 'reed', blades: 6, length: [0.22, 0.4], width: 0.03, spread: 1.1, regional: 0.75, base: [0.17, 0.28, 0.1], tip: [0.32, 0.43, 0.16] },
  {
    name: 'cattail',
    blades: 5,
    length: [0.28, 0.45],
    width: 0.035,
    spread: 0.9,
    regional: 0.75,
   
    base: [0.16, 0.26, 0.1],
    tip: [0.31, 0.4, 0.15],
    head: { length: 0.15, width: 0.06, color: [0.32, 0.2, 0.11] },
  },
  {
    // Yellow flag iris: broad sword leaves and a yellow flower.
    name: 'iris',
    blades: 5,
    length: [0.22, 0.38],
    width: 0.05,
    spread: 0.8,
    regional: 0.5,
   
    base: [0.18, 0.3, 0.13],
    tip: [0.31, 0.42, 0.18],
    head: { length: 0.07, width: 0.08, color: [0.88, 0.76, 0.22] },
  },
  { name: 'shrub', blades: 8, length: [0.12, 0.22], width: 0.085, spread: Math.PI * 2, regional: 0.35, base: [0.12, 0.2, 0.08], tip: [0.21, 0.3, 0.11] },
  {
    // Pickerelweed: broad, heart-ish leaves and a lavender flower spike.
    name: 'pickerelweed',
    blades: 5,
    length: [0.16, 0.26],
    width: 0.075,
    spread: 2.4,
    regional: 0.5,
   
    base: [0.17, 0.3, 0.13],
    tip: [0.3, 0.42, 0.18],
    head: { length: 0.1, width: 0.045, color: [0.5, 0.42, 0.64] },
  },
]

/** Kinds with lengths converted to px. */
export const PLANT_KINDS = KINDS_METERS.map((k) => ({
  ...k,
  length: k.length.map((m) => m * PX_PER_METER),
  width: k.width * PX_PER_METER,
  head: k.head && { ...k.head, length: k.head.length * PX_PER_METER, width: k.head.width * PX_PER_METER },
}))

export const PLANT = Object.fromEntries(PLANT_KINDS.map((k, i) => [k.name.toUpperCase(), i]))

/** The param holding how much of a kind grows, e.g. 'pickerelweed' -> 'plantPickerelweed'. */
export const plantAmountKey = (name) => `plant${name[0].toUpperCase()}${name.slice(1)}`

/**
 * A collection of plants, stored flat so it uploads to the GPU as one
 * instance buffer. Plants are static; their sway comes from the GPU
 * disturbance field (SwayField), not from per-plant CPU state.
 *
 * `bloom` (one per plant, 0..1) is how much nectar a flower holds: the midges
 * drink it down and the flower's head fades towards its leaves until it
 * refills. Bump `bloomVersion` after changing it.
 */
export class Vegetation {
  constructor() {
    this.count = 0
    this.data = new Float32Array(1024 * PLANT_STRIDE)
    this.bloom = new Float32Array(1024)
    this.version = 0
    this.bloomVersion = 0
  }

  clear() {
    this.count = 0
    this.version++
  }

  add(kind, x, y, scale = 1, rotation = Math.random() * Math.PI * 2, seed = Math.random(), brown = 0, yellow = 0, land = false) {
    if ((this.count + 1) * PLANT_STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
      const bloom = new Float32Array(this.bloom.length * 2)
      bloom.set(this.bloom)
      this.bloom = bloom
    }
    const o = this.count * PLANT_STRIDE
    this.data[o] = x
    this.data[o + 1] = y
    this.data[o + 2] = scale
    this.data[o + 3] = rotation
    this.data[o + 4] = kind
    this.data[o + 5] = seed
    this.data[o + 6] = brown
    this.data[o + 7] = yellow + (land ? LAND_FLAG : 0)
    this.bloom[this.count] = 1
    this.count++
    this.version++
  }
}
