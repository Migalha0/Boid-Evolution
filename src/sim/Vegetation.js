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
 * `bloom` (one per plant, 0..1) is how much nectar a flower holds; the
 * flower's head fades towards its leaves as it empties. Nothing drinks it
 * for now, so it stays full. Bump `bloomVersion` after changing it.
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

/**
 * Plants sorted by kind (stable): each plant's slot in that order, and each
 * kind's start and count. The renderer draws plants in this order, and the
 * nectar texture (gpu/PondGpu.js) is laid out by these slots.
 */
export function plantSlots(vegetation) {
  const n = vegetation.count
  const src = vegetation.data
  const counts = new Array(PLANT_KINDS.length).fill(0)
  for (let i = 0; i < n; i++) counts[src[i * PLANT_STRIDE + 4]]++
  const starts = []
  let acc = 0
  for (const c of counts) {
    starts.push(acc)
    acc += c
  }
  const cursor = [...starts]
  const slot = new Int32Array(n)
  for (let i = 0; i < n; i++) slot[i] = cursor[src[i * PLANT_STRIDE + 4]]++
  return { slot, starts, counts }
}

/** Regional tip colours (render/shaders.js plantVS): olive green, yellow-green, dry tan-brown. */
const GREEN_TIP = [0.35, 0.42, 0.17]
const YELLOW_TIP = [0.5, 0.52, 0.23]
const BROWN_TIP = [0.5, 0.42, 0.27]
/** A drunk-down flower fades this far towards a dull brown, from its leaves' tip colour. */
const WITHER = [0.42, 0.38, 0.26]
const WITHER_MIX = 0.35
/** How far one plant's head strays from its kind's colour at variation 1: hue (radians), saturation, brightness. */
const FLOWER_HUE = 0.14
const FLOWER_SAT = 0.1
const FLOWER_VALUE = 0.1

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const hash = (n) => {
  const s = Math.sin(n) * 43758.5453
  return s - Math.floor(s)
}

/** Colour `c` turned by `angle` around the grey axis, its saturation x `sat`, brightness x `value`. */
function shift(c, angle, sat, value) {
  const k = Math.sqrt(1 / 3)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dot = (c[0] + c[1] + c[2]) * k
  // Rodrigues' rotation about (1, 1, 1) / sqrt 3.
  const cross = [k * (c[2] - c[1]), k * (c[0] - c[2]), k * (c[1] - c[0])]
  const turned = c.map((v, i) => v * cos + cross[i] * sin + k * dot * (1 - cos))
  const grey = (turned[0] + turned[1] + turned[2]) / 3
  return turned.map((v) => Math.min(1, Math.max(0, (grey + (v - grey) * sat) * value)))
}

/**
 * A plant's head colours, fresh and withered (rgb 0..1 each), or null for a
 * kind without a head. Each plant's head (flowers, cattail spikes) strays a
 * little from its kind's colour (by its seed, as far as `variation` says:
 * params.flowerVariation, 1 = FLOWER_HUE etc.); the withered colour is its leaves' tip colour
 * (regional, as plantVS colours blades) faded towards a dull brown, with a
 * little of the same stray. The renderer draws the head between the two by
 * its nectar, and midges see that same colour (gpu/PondGpu.js flowerLook).
 */
export function headColours(vegetation, i, variation = 1) {
  const d = vegetation.data
  const o = i * PLANT_STRIDE
  const kind = PLANT_KINDS[d[o + 4]]
  if (!kind.head) return null
  const seed = d[o + 5]
  let yellow = d[o + 7]
  if (yellow >= LAND_FLAG) yellow -= LAND_FLAG
  const regionTip = mix(mix(GREEN_TIP, YELLOW_TIP, yellow), BROWN_TIP, d[o + 6])
  const angle = (hash(seed * 17.3) * 2 - 1) * FLOWER_HUE * variation
  const sat = Math.max(0, 1 + (hash(seed * 29.1) * 2 - 1) * FLOWER_SAT * variation)
  const value = Math.max(0, 1 + (hash(seed * 41.7) * 2 - 1) * FLOWER_VALUE * variation)
  const fresh = shift(kind.head.color, angle, sat, value)
  const withered = shift(mix(mix(kind.tip, regionTip, kind.regional ?? 0), WITHER, WITHER_MIX), angle * 0.3, 1, 1 + (value - 1) * 0.5)
  return { fresh, withered }
}
