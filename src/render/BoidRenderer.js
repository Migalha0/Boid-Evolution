import { createFramebuffer, createProgram, createTexture } from '../gpu/gl.js'
import { SCUM_CELL } from '../gpu/ScumField.js'
import { PAD_STRIDE } from '../sim/LilyPads.js'
import { LAND_LEVEL } from '../sim/PondMap.js'
import { MAX_KINDS, PLANT_KINDS, PLANT_STRIDE, plantSlots } from '../sim/Vegetation.js'
import { evalCurve } from '../sim/curve.js'
import { cloudTune } from '../sim/Rain.js'
import { windPattern, windVector } from '../sim/Wind.js'
import { createCloudTexture } from './clouds.js'
import * as S from './shaders.js'
import { FULL_VISION_Z, GROUND_VISION, VISION_GENE } from '../species/midges.js'

const VEL_LOW = [0.7, 0.8, 0.82]
const VEL_HIGH = [0.95, 0.6, 0.3]
const ACC_LOW = [0.6, 0.4, 0.75]
const ACC_HIGH = [0.9, 0.4, 0.55]
const VISION = [0.75, 0.85, 0.85]
const VISION_SELECTED = [0.95, 0.8, 0.45]
/** Range ring opacity for every one / the selected one (fish and midges alike). */
const RANGE_ALPHA = 0.18
const RANGE_SELECTED_ALPHA = 0.8
/** With 'all', rings fade as they get many, so thousands don't wash the pond out. */
const rangeAlpha = (n) => RANGE_ALPHA * Math.min(1, Math.max(0.02, 400 / Math.max(n, 1)))
/** Lily pads float lower than the scum mats: their shadow offset, relative to the scum's. */
const PAD_HEIGHT = 0.275

/**
 * Params -> the shaders' `Tunables` uniform block (TUNE in shaders.js): vec4s,
 * in slot order (the last one padded). Each entry turns panel units into the
 * shader's. After them, from slot MURK_SLOT, the murk curve at MURK_SAMPLES
 * even depths.
 */
const TUNABLES = [
  (p) => 1 - p.shadowDarkness, // SHADOW
  (p) => 1 - p.plantSelfShadow, // PLANT_SELF_SHADE
  (p, r) => r.clouds[0], // CLOUD_SCALE
  (p, r) => r.clouds[1], // CLOUD_COVER threshold (thicker in the rain: sim/Rain.js cloudTune)
  (p, r) => r.clouds[2], // CLOUD_EDGE
  (p, r) => r.clouds[3], // CLOUD_SHADE (darker in the rain)
  (p) => p.swirlStrength,
  (p) => p.swirlSize,
  (p) => p.swirlSpeed,
  (p) => p.causticStrength, // CAUSTIC_STEP
  (p) => p.causticDepth,
  (p) => p.causticSize,
  (p) => p.causticSpeed,
  (p) => p.rippleStrength, // RIPPLE_ALPHA
  (p) => p.rippleWavelength,
  (p) => p.rippleSpeed,
  (p) => p.refraction,
  (p) => p.vignette,
  (p) => p.plantBreeze, // BREEZE
  (p) => p.plantBend,
  (p) => (p.dithering ? 1 : 0),
  (p) => p.swimWiggle,
  (p) => p.deepFade,
  (p) => p.siltOpacity,
  (p) => (p.showPlants ? p.sludgeAmount : 0), // SLUDGE
]
const MURK_SLOT = 28
const MURK_SAMPLES = 12
const TUNE_BINDING = 0

// Texture units: sim state/aux are bound once per frame and shared by all programs.
const UNIT_STATE = 0
const UNIT_AUX = 1
/**
 * Midges flying or falling below this height (px) are drawn among the plants
 * (under overhanging leaves, like one resting on the water) rather than over
 * them: a hatchling (at 1 px) or one dropping dead (from 2 px) beside the
 * water no longer pops into view over the plants and out again.
 */
const MIDGE_LOW_FLIGHT = 3
const UNIT_VERT = 2 // the boid's vert (z, vz): fish depth, midge height; bound per draw (each species its own)
const UNIT_TRAITS = 3
const UNIT_ELEV = 4
const UNIT_SCENE = 5
const UNIT_SDF = 6
const UNIT_SWAY = 7
const UNIT_SHADOW = 8
const UNIT_SCUM = 9
const UNIT_SCUM_BAKE = 10
const UNIT_PLANTS = 11
/** Plant data texture width in texels (2 per plant). */
const PLANT_TEX_W = 2048
const UNIT_CLOUDS = 12
const UNIT_BG = 13
const UNIT_SURFACE = 14 // surface SDF: shore + trunks breaking the surface
const UNIT_LOGS = 15
const UNIT_TRUNKS = 16 // baked trunk map (MapTextures.trunkMap)
const UNIT_BLOOM = 17 // flower nectar, one texel per plant (sorted like the plants)
const UNIT_SCUM_LAYER = 18 // this frame's scum, unshaded (see drawScum)
const UNIT_SILT = 19
/** A GPU species' textures for the midge programs: state, aux, traits, state at the frame's start, range gene, items, nectar. */
const UNIT_M_STATE = 20
const UNIT_M_AUX = 21
const UNIT_M_TRAITS = 22
const UNIT_M_PREV = 23
const UNIT_M_RANGE = 24
const UNIT_M_ITEMS = 25
const UNIT_M_NECTAR = 26
const UNIT_PLANT_DENSITY = 27 // how crowded with plants, for the scum bake
const UNIT_TRUNK_LOOK = 28 // baked trunk colours (MapTextures.trunkLook)
const UNIT_TINT = 29 // the plants' colour regions (MapTextures.tint), for the soil
const UNIT_FLOWER_LOOK = 30 // each plant's head colours, fresh and withered (gpu/PondGpu.js flowerLook)
const UNIT_M_AUX1 = 31 // a GPU species' aux1 (midges: when and where it last laid), for the ripples
/** Midge trails: colour (a pale brown, so it reads over dark water), head opacity, and the fastest a midge flies (px/s). */
const MIDGE_TRAIL = [0.36, 0.3, 0.22]
const TRAIL_ALPHA = 0.55
const TRAIL_MAX_SPEED = 200
/** The selected midge's view: lines to the midges it sees; rings round items, per source (gpu/PondGpu.js SOURCE order). */
const SEEN_MIDGES = [0.85, 0.9, 0.9, 0.3]
/** Plant density for the scum bake: cell size (px), and plants per (blurred) cell that count as fully crowded. */
const PLANT_DENSITY_CELL = 12
const PLANT_DENSITY_FULL = 1.5

/** Frond cells drawn beyond each side of the view: fronds drift up to 30 px (ScumField). */
const SCUM_MARGIN_CELLS = 12


/**
 * Shadow offset per px of height, away from the sun.
 * @param azimuth sun direction in degrees, clockwise from north (screen up)
 * @param elevation sun height above the horizon in degrees
 */
/**
 * The light on the scene from the sun's height (degrees) and the overall
 * brightness: stronger the higher it stands (from 0.7x near the horizon to
 * 1.2x overhead), and warmer when it is low.
 */
function sunlight(elevation, brightness) {
  const h = Math.sin((elevation * Math.PI) / 180)
  const level = brightness * (0.7 + 0.5 * h)
  const warm = 1 - Math.min(1, Math.max(0, (elevation - 12) / 33)) // 1 near the horizon, 0 from 45°
  return [level, level * (1 - 0.1 * warm), level * (1 - 0.25 * warm)]
}

function lightVector(azimuth, elevation) {
  const a = (azimuth * Math.PI) / 180
  const len = 1 / Math.tan((Math.max(1, Math.min(89, elevation)) * Math.PI) / 180)
  return [-Math.sin(a) * len, Math.cos(a) * len]
}

/**
 * Draws the scene into a low-resolution framebuffer (1 pixel per
 * `pixelSize` CSS px), then upscales it to the canvas with hard pixel edges,
 * ordered dithering and a vignette for a lo-fi look.
 */
export class BoidRenderer {
  constructor(gl) {
    this.gl = gl
    this.width = 1
    this.height = 1

    this.boidProg = createProgram(gl, S.boidVS, S.boidFS)
    this.vectorProg = createProgram(gl, S.vectorVS, S.vectorFS)
    this.visionProg = createProgram(gl, S.visionVS, S.visionFS)
    this.waterProg = createProgram(gl, S.fieldVS, S.waterFS)
    this.plantProg = createProgram(gl, S.plantVS, S.plantFS)
    this.scumProg = createProgram(gl, S.scumVS, S.scumFS)
    this.scumBakeProg = createProgram(gl, S.fieldVS, S.scumBakeFS)
    this.scumShadowProg = createProgram(gl, S.fieldVS, S.scumShadowFS)
    this.scumCompositeProg = createProgram(gl, S.fieldVS, S.scumCompositeFS)
    this.shadowProg = createProgram(gl, S.fieldVS, S.shadowFS)
    this.waterFloorProg = createProgram(gl, S.fieldVS, S.waterFloorFS)
    this.waterSurfaceProg = createProgram(gl, S.fieldVS, S.waterSurfaceFS)
    this.padProg = createProgram(gl, S.padVS, S.padFS)
    this.midgeProg = createProgram(gl, S.midgeVS, S.insectFS)
    this.trailProg = createProgram(gl, S.trailVS, S.trailFS)
    this.midgeTrailProg = createProgram(gl, S.midgeTrailVS, S.trailFS)
    this.seenBoidsProg = createProgram(gl, S.seenBoidsVS, S.trailFS)
    this.seenItemsProg = createProgram(gl, S.seenItemsVS, S.trailFS)
    this.logProg = createProgram(gl, S.logVS, S.logFS)
    this.siltProg = createProgram(gl, S.fieldVS, S.siltFS)
    this.postProg = createProgram(gl, S.fieldVS, S.postFS)
    this.leaderProg = createProgram(gl, S.leaderVS, S.leaderFS)
    this.inspectorRect = null // the inspector panel (css px of the canvas), for the leader line
    this.programs = [
      this.boidProg,
      this.vectorProg,
      this.visionProg,
      this.waterProg,
      this.plantProg,
      this.scumProg,
      this.scumBakeProg,
      this.scumShadowProg,
      this.scumCompositeProg,
      this.shadowProg,
      this.waterFloorProg,
      this.waterSurfaceProg,
      this.padProg,
      this.midgeProg,
      this.trailProg,
      this.midgeTrailProg,
      this.seenBoidsProg,
      this.seenItemsProg,
      this.logProg,
      this.siltProg,
      this.postProg,
    ]
    // One uniform buffer of look parameters, shared by every program using it.
    this.tuneData = new Float32Array(MURK_SLOT + MURK_SAMPLES)
    this.tuneBuf = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.tuneBuf)
    gl.bufferData(gl.UNIFORM_BUFFER, this.tuneData.byteLength, gl.DYNAMIC_DRAW)
    for (const { program } of this.programs) {
      const block = gl.getUniformBlockIndex(program, 'Tunables')
      if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, block, TUNE_BINDING)
    }
    for (const p of [this.boidProg, this.scumCompositeProg, this.plantProg, this.padProg, this.logProg, this.shadowProg, this.waterFloorProg]) {
      gl.useProgram(p.program)
      gl.uniform1i(p.u.u_shadowMask, UNIT_SHADOW)
    }
    // Bound in place of the mask while the mask itself is being drawn (no feedback loop).
    this.blankTex = createTexture(gl, gl.R8, 1, 1)
    for (const p of [this.boidProg, this.vectorProg, this.visionProg]) {
      gl.useProgram(p.program)
      gl.uniform1i(p.u.u_state, UNIT_STATE)
      gl.uniform1i(p.u.u_aux, UNIT_AUX)
      gl.uniform1i(p.u.u_traits, UNIT_TRAITS)
      gl.uniform1i(p.u.u_background, UNIT_BG)
    }
    gl.useProgram(this.waterProg.program)
    gl.uniform1i(this.waterProg.u.u_elev, UNIT_ELEV)
    gl.uniform1i(this.waterProg.u.u_sdf, UNIT_SDF)
    gl.uniform1i(this.waterProg.u.u_tint, UNIT_TINT)
    gl.uniform1i(this.waterProg.u.u_trunks, UNIT_TRUNKS)
    gl.useProgram(this.boidProg.program)
    gl.uniform1i(this.boidProg.u.u_vert, UNIT_VERT)
    gl.uniform1i(this.boidProg.u.u_trunks, UNIT_TRUNKS)
    gl.uniform1i(this.boidProg.u.u_elev, UNIT_ELEV)
    gl.uniform1i(this.boidProg.u.u_silt, UNIT_SILT)
    gl.useProgram(this.siltProg.program)
    gl.uniform1i(this.siltProg.u.u_silt, UNIT_SILT)
    gl.uniform1i(this.siltProg.u.u_background, UNIT_BG)
    gl.useProgram(this.logProg.program)
    gl.uniform1i(this.logProg.u.u_logs, UNIT_LOGS)
    gl.uniform1i(this.logProg.u.u_background, UNIT_BG)
    gl.uniform1i(this.logProg.u.u_trunkLook, UNIT_TRUNK_LOOK)
    gl.uniform1i(this.logProg.u.u_elev, UNIT_ELEV)
    // Scum floats: it keeps to the surface SDF, so it never lies on a trunk.
    gl.useProgram(this.scumProg.program)
    gl.uniform1i(this.scumProg.u.u_sdf, UNIT_SURFACE)
    gl.uniform1i(this.scumProg.u.u_scumDisp, UNIT_SCUM)
    gl.uniform1i(this.scumProg.u.u_scumBake, UNIT_SCUM_BAKE)
    for (const p of [this.scumShadowProg, this.scumCompositeProg]) {
      gl.useProgram(p.program)
      gl.uniform1i(p.u.u_scumLayer, UNIT_SCUM_LAYER)
    }
    gl.useProgram(this.shadowProg.program)
    gl.uniform1i(this.shadowProg.u.u_background, UNIT_BG)
    gl.useProgram(this.scumShadowProg.program)
    gl.uniform1i(this.scumShadowProg.u.u_elev, UNIT_ELEV)
    gl.useProgram(this.scumBakeProg.program)
    gl.uniform1i(this.scumBakeProg.u.u_elev, UNIT_ELEV)
    gl.uniform1i(this.scumBakeProg.u.u_sdf, UNIT_SURFACE)
    this.setupPlantKinds()
    for (const p of [this.waterFloorProg, this.waterSurfaceProg]) {
      gl.useProgram(p.program)
      gl.uniform1i(p.u.u_background, UNIT_BG)
      gl.uniform1i(p.u.u_sdf, UNIT_SDF)
      gl.uniform1i(p.u.u_clouds, UNIT_CLOUDS)
    }
    gl.uniform1i(this.waterSurfaceProg.u.u_sway, UNIT_SWAY)
    // Ripples keep off trunks breaking the surface.
    gl.uniform1i(this.waterSurfaceProg.u.u_sdf, UNIT_SURFACE)
    gl.useProgram(this.postProg.program)
    gl.uniform1i(this.postProg.u.u_scene, UNIT_SCENE)
    gl.uniform1i(this.postProg.u.u_clouds, UNIT_CLOUDS)
    gl.activeTexture(gl.TEXTURE0 + UNIT_CLOUDS)
    this.cloudTex = createCloudTexture(gl)
    this.cloudShift = [0, 0] // how far the clouds have drifted (world px): the live wind's (sim/Wind.js)
    this.windTravel = [0, 0] // how far the wind has blown (unit vector x s), for patterns drifting with it
    this.causticShift = [0, 0] // how far the caustics have drifted downwind (noise tiles)
    this.cloudTime = null

    this.vao = gl.createVertexArray()

    this.padBuf = gl.createBuffer()
    this.padVao = gl.createVertexArray()
    gl.bindVertexArray(this.padVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.padBuf)
    for (let loc = 0; loc < 2; loc++) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, PAD_STRIDE * 4, loc * 16)
      gl.vertexAttribDivisor(loc, 1)
    }
    // Lines (the focus overlays), one buffer per source, made on first use.
    this.lineSets = new Map()
    this.plantTex = null
    gl.bindVertexArray(null)
    this.plantVersion = -1
    this.plantBatches = []

    this.padVersion = -1
    this.scumSpots = new Float32Array(0)
    this.scumVersion = 0
    this.floorKey = ''
    this.bgKey = ''
    this.scumKey = ''
    this.scumBakeTex = null
    this.scumBakeFbo = null
    this.light = [0, 0]
    this.rain = 0 // 0 dry .. 1 downpour: the live rain's (sim/Rain.js)

    this.viewOffset = [0, 0]
    this.pixelSize = 0
    this.low = [0, 0]
    this.sceneTex = null
    this.sceneFbo = null
  }

  /** Plant kinds are static: upload their parameters once as uniform arrays. */
  setupPlantKinds() {
    const gl = this.gl
    const shape = new Float32Array(MAX_KINDS * 4)
    const base = new Float32Array(MAX_KINDS * 3)
    const tip = new Float32Array(MAX_KINDS * 3)
    const head = new Float32Array(MAX_KINDS * 4)
    const spread = new Float32Array(MAX_KINDS)
    const regional = new Float32Array(MAX_KINDS)
    PLANT_KINDS.forEach((k, i) => {
      shape.set([k.blades, k.length[0], k.length[1], k.width], i * 4)
      base.set(k.base, i * 3)
      tip.set(k.tip, i * 3)
      spread[i] = k.spread
      regional[i] = k.regional ?? 0
      if (k.head) head.set([1, k.head.length, k.head.width, 0], i * 4)
    })
    const { program, u } = this.plantProg
    gl.useProgram(program)
    gl.uniform4fv(u['u_kindShape[0]'], shape)
    gl.uniform3fv(u['u_kindBase[0]'], base)
    gl.uniform3fv(u['u_kindTip[0]'], tip)
    gl.uniform4fv(u['u_kindHead[0]'], head)
    gl.uniform1fv(u['u_kindSpread[0]'], spread)
    gl.uniform1fv(u['u_kindRegional[0]'], regional)
    gl.uniform1i(u.u_sway, UNIT_SWAY)
    gl.uniform1i(u.u_plants, UNIT_PLANTS)
    gl.uniform1i(u.u_bloom, UNIT_BLOOM)
    gl.uniform1i(u.u_flowerLook, UNIT_FLOWER_LOOK)
    gl.useProgram(this.padProg.program)
    gl.uniform1i(this.padProg.u.u_sway, UNIT_SWAY)
    gl.uniform1i(this.padProg.u.u_elev, UNIT_ELEV)
    gl.useProgram(this.midgeProg.program)
    gl.uniform1i(this.midgeProg.u.u_elev, UNIT_ELEV)
    // Midge textures (a GPU species, gpu/boids/BoidKernel.js) for every program that reads them.
    for (const prog of [this.midgeProg, this.midgeTrailProg, this.seenBoidsProg, this.seenItemsProg]) {
      gl.useProgram(prog.program)
      gl.uniform1i(prog.u.u_mState, UNIT_M_STATE)
      gl.uniform1i(prog.u.u_mAux, UNIT_M_AUX)
      gl.uniform1i(prog.u.u_mTraits, UNIT_M_TRAITS)
      gl.uniform1i(prog.u.u_mPrev, UNIT_M_PREV)
      gl.uniform1i(prog.u.u_rangeTex, UNIT_M_RANGE)
      gl.uniform1i(prog.u.u_items, UNIT_M_ITEMS)
      gl.uniform1i(prog.u.u_nectar, UNIT_M_NECTAR)
      gl.uniform1i(prog.u.u_flowerLook, UNIT_FLOWER_LOOK)
      gl.uniform1i(prog.u.u_mAux1, UNIT_M_AUX1)
      gl.uniform1i(prog.u.u_mVert, UNIT_VERT)
    }
    gl.useProgram(this.visionProg.program)
    gl.uniform1i(this.visionProg.u.u_rangeTex, UNIT_M_RANGE)
    gl.uniform1i(this.visionProg.u.u_ringVert, UNIT_VERT)
  }

  /** @param viewOffset world position of the screen's top-left corner */
  resize(width, height, viewOffset = [0, 0]) {
    this.viewOffset = viewOffset
    this.cssWidth = width
    this.cssHeight = height
    this.pixelSize = 0 // force the low-res target to be rebuilt
  }

  /**
   * (Re)create the low-res scene target when size or pixel size changes.
   * The canvas itself is only scene-sized: the browser upscales it with
   * nearest filtering (CSS image-rendering: pixelated), so nothing is ever
   * drawn or composited at full device resolution.
   */
  ensureScene(pixelSize) {
    if (pixelSize === this.pixelSize && this.sceneTex) return
    const gl = this.gl
    const w = Math.max(1, Math.round(this.cssWidth / pixelSize))
    const h = Math.max(1, Math.round(this.cssHeight / pixelSize))
    gl.canvas.width = w
    gl.canvas.height = h
    gl.deleteTexture(this.sceneTex)
    gl.deleteFramebuffer(this.sceneFbo)
    gl.deleteTexture(this.bgTex)
    gl.deleteFramebuffer(this.bgFbo)
    this.sceneTex = createTexture(gl, gl.RGBA8, w, h)
    this.sceneFbo = createFramebuffer(gl, [this.sceneTex])
    // Cached static background (water + land); see drawBackground().
    this.bgTex = createTexture(gl, gl.RGBA8, w, h)
    this.bgFbo = createFramebuffer(gl, [this.bgTex])
    this.bgKey = ''
    // Hard plant-shadow mask at scene resolution; see drawShadowMask().
    gl.deleteTexture(this.maskTex)
    gl.deleteFramebuffer(this.maskFbo)
    this.maskTex = createTexture(gl, gl.RGBA8, w, h)
    this.maskFbo = createFramebuffer(gl, [this.maskTex])
    // This frame's scum (see drawScum).
    gl.deleteTexture(this.scumLayerTex)
    gl.deleteFramebuffer(this.scumLayerFbo)
    this.scumLayerTex = createTexture(gl, gl.RGBA8, w, h)
    this.scumLayerFbo = createFramebuffer(gl, [this.scumLayerTex])
    this.pixelSize = pixelSize
    this.low = [w, h]
    // The scene shows exactly the canvas' world extent; a scene pixel is
    // ~pixelSize world px (exactly, up to rounding the pixel count).
    this.width = this.cssWidth
    this.height = this.cssHeight
    this.cell = [this.width / w, this.height / h]
  }

  /** Bind program and per-frame layout uniforms. */
  use(prog, sim, instanceOffset = 0) {
    const gl = this.gl
    gl.useProgram(prog.program)
    gl.uniform2f(prog.u.u_resolution, this.width, this.height)
    gl.uniform2fv(prog.u.u_viewOffset, this.viewOffset)
    gl.uniform1i(prog.u.u_texW, sim.texW)
    gl.uniform1i(prog.u.u_texShift, sim.texShift)
    gl.uniform1i(prog.u.u_instanceOffset, instanceOffset)
    return prog.u
  }

  /**
   * @param {import('../gpu/MapTextures.js').MapTextures} mapTex
   * @param {import('../gpu/SwayField.js').SwayField} sway
   * @param {import('../sim/Vegetation.js').Vegetation} vegetation
   */
  /**
   * @param midges the midges to draw ({ kernel, prev, selected, pond }: a GPU
   *   species, its state at the frame's start, the selected one, the pond's
   *   items and nectar), or null
   */
  render(sim, mapTex, vegetation, sway, scum, silt, pads, midges, params, selected, time, overlays = []) {
    // The midges' wing flutter runs on real time (its pace the same at any sim speed), but stops while paused.
    const now = performance.now() / 1000
    if (!params.paused) this.flutterClock = ((this.flutterClock ?? 0) + Math.min(0.1, now - (this.flutterLast ?? now))) % 3600
    this.flutterLast = now
    const gl = this.gl
    const n = sim.count
    const px = params.pixelSize
    this.ensureScene(px)
    this.light = lightVector(params.sunAzimuth, params.sunElevation)
    // The wind as it blows now (sim/Wind.js), else as set.
    const wind = this.liveWind?.direction != null ? this.liveWind : { direction: params.windDirection, speed: params.cloudSpeed }
    this.wind = windVector(wind.direction)
    this.windSpeed = wind.speed
    const pattern = windPattern(wind.direction)
    this.windPair = pattern.pair
    this.windMix = pattern.mix
    if (this.liveWind) this.cloudShift = this.liveWind.shift
    this.floatHeight = params.floatHeight
    this.elevCell = mapTex.elevCell
    this.elevDims = mapTex.elevDims
    // The floor's sludge is sized and murked by the panel: re-render the cached background when those change.
    this.floorKey = `${params.murkCurve}|${params.showPlants ? params.sludgeAmount : 0}|${params.floorLitter}|${params.floorStones}|${params.floorTwigs}|${params.sunAzimuth}|${params.sunElevation}|${params.waterTint}`
    this.floorDetails = [params.floorLitter, params.floorStones, params.floorTwigs]
    this.waterTint = params.waterTint
    this.rain = this.liveRain?.level ?? 0
    this.clouds = cloudTune(params, this.rain)
    TUNABLES.forEach((f, i) => (this.tuneData[i] = f(params, this)))
    for (let i = 0; i < MURK_SAMPLES; i++) this.tuneData[MURK_SLOT + i] = evalCurve(params.murkCurve, i / (MURK_SAMPLES - 1))
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.tuneBuf)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.tuneData)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, TUNE_BINDING, this.tuneBuf)
    this.advanceClouds(this.windSpeed, params.causticSpeed, time)
    gl.activeTexture(gl.TEXTURE0 + UNIT_CLOUDS)
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo)
    gl.viewport(0, 0, this.low[0], this.low[1])
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied alpha
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0 + UNIT_SWAY)
    gl.bindTexture(gl.TEXTURE_2D, sway.texture)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM)
    gl.bindTexture(gl.TEXTURE_2D, scum.texture)
    gl.activeTexture(gl.TEXTURE0 + UNIT_ELEV)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.elevation)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SDF)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.sdf)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SURFACE)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.surface)
    gl.activeTexture(gl.TEXTURE0 + UNIT_LOGS)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.logs)
    gl.activeTexture(gl.TEXTURE0 + UNIT_TRUNKS)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.trunkMap)
    gl.activeTexture(gl.TEXTURE0 + UNIT_TRUNK_LOOK)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.trunkLook)
    if (params.showPlants) {
      this.bakeScum(mapTex, params.scumAmount, vegetation, params.scumAmongPlants)
      this.drawScum(mapTex, scum, time)
    }
    this.drawShadowMask(vegetation, mapTex, sway, scum, pads, time, params.showPlants)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo)
    gl.viewport(0, 0, this.low[0], this.low[1])
    const waterMotion = params.showWaterMotion
    this.drawBackground(mapTex, !waterMotion)
    gl.activeTexture(gl.TEXTURE0 + UNIT_BG)
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex) // water colour + depth: animated floor, murk on the fish
    if (waterMotion) this.drawWater(this.waterFloorProg, params, sway, mapTex, time, false)
    else if (params.showPlants) this.darkenShadows()
    this.drawLogs(mapTex, 0) // under water: below the fish swimming over them

    gl.activeTexture(gl.TEXTURE0 + UNIT_STATE)
    gl.bindTexture(gl.TEXTURE_2D, sim.stateTexture)
    gl.activeTexture(gl.TEXTURE0 + UNIT_AUX)
    gl.bindTexture(gl.TEXTURE_2D, sim.auxTexture)
    gl.activeTexture(gl.TEXTURE0 + UNIT_TRAITS)
    gl.bindTexture(gl.TEXTURE_2D, sim.traitsTexture)

    const cosHalfFov = Math.cos(((params.fov * Math.PI) / 180) / 2)
    const sepRatio = Math.min(1, params.separation / params.perception)
    const hasSel = selected >= 0 && selected < n

    // Range rings, drawn with the midges' (drawMidgeRanges) and in
    // their style: a thin ring at the vision range, over its field of view;
    // faint for every fish ('all'), bright for the selected one. Only the
    // outer ring of the shader's two (no fill, no separation ring).
    const drawRanges = () => {
      if (params.fishVisionMode === 'off' || !n) return
      const ring = (offset, count, color, alpha) => {
        const u = this.use(this.visionProg, sim, offset)
        gl.uniform1f(u.u_radius, params.perception)
        gl.uniform1f(u.u_cosHalfFov, cosHalfFov)
        gl.uniform1f(u.u_sepRatio, sepRatio)
        gl.uniform3fv(u.u_color, color)
        gl.uniform1f(u.u_fill, 0)
        gl.uniform1f(u.u_rim, alpha)
        gl.uniform1i(u.u_rings, 1)
        gl.uniform1f(u.u_band, Math.max(this.cell[0], this.cell[1]))
        gl.uniform1f(u.u_halfSpan, Math.min(Math.PI, ((params.fov * Math.PI) / 180) / 2 + 0.05))
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * S.RING_SEGMENTS, count)
      }
      if (params.fishVisionMode === 'all') ring(0, n, VISION, rangeAlpha(n))
      if (hasSel) ring(selected, 1, VISION_SELECTED, RANGE_SELECTED_ALPHA)
    }

    const drawBoids = (offset, count, mode, size, shift = [0, 0], tint = [1, 1, 1]) => {
      gl.activeTexture(gl.TEXTURE0 + UNIT_VERT)
      gl.bindTexture(gl.TEXTURE_2D, sim.vertTexture)
      const u = this.use(this.boidProg, sim, offset)
      gl.uniform1f(u.u_size, size)
      gl.uniform2fv(u.u_shift, shift)
      gl.uniform2fv(u.u_siltExtent, silt.extent)
      gl.uniform1i(u.u_mode, mode)
      gl.uniform3fv(u.u_tint, tint)
      gl.uniform1f(u.u_maxForce, params.maxForce)
      gl.uniform1f(u.u_pixel, this.cell[0])
      gl.uniform2fv(u.u_light, this.light)
      gl.uniform1f(u.u_elevCell, mapTex.elevCell)
      gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
      // Light up the fish the selected one sees (the focus overlay draws its forces).
      gl.uniform1i(u.u_focusId, hasSel && mode === 0 && offset === 0 ? selected : -1)
      gl.uniform1f(u.u_focusRange, params.perception)
      gl.uniform1f(u.u_focusCosFov, params.fov >= 359.9 ? -2 : cosHalfFov)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, S.FISH_VERTS, count)
    }

    // Keep arrows at least one scene pixel wide so they don't break up.
    const offset = params.boidSize * 1.6
    if (params.showSteering) {
      this.drawVectors(sim, n, 1, params.steeringScale, params.maxForce, offset, ACC_LOW, ACC_HIGH, Math.max(1.2, px))
    }
    if (params.showVelocity) {
      this.drawVectors(sim, n, 0, params.velocityScale, params.maxSpeed, offset, VEL_LOW, VEL_HIGH, Math.max(1.5, px))
    }

    if (params.shadowDarkness > 0) drawBoids(0, n, 1, params.boidSize) // shadows on the floor
    const m = params.showInsects && midges?.kernel.count ? midges : null
    if (m && params.shadowDarkness > 0) this.drawMidges(m, 2, time)
    if (params.siltOpacity > 0) this.drawSilt(silt)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SILT)
    gl.bindTexture(gl.TEXTURE_2D, silt.texture) // the fish read it too (veiled inside a cloud)
    drawBoids(0, n, 0, params.boidSize)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SWAY)
    gl.bindTexture(gl.TEXTURE_2D, sway.texture)
    if (waterMotion) this.drawWater(this.waterSurfaceProg, params, sway, mapTex, time, true)
    if (params.showPlants) {
      // Surface layers, over the fish: scum, then lily pads, then emergent plants.
      this.compositeScum()
      this.drawPads(pads, sway, time)
      if (m) {
        this.drawMidges(m, 3, time, params) // ripples where they laid or fell
        this.drawMidges(m, 0, time) // on the water, under overhanging plants
      }
      this.drawPlants(vegetation, sway, time)
    } else if (m) {
      this.drawMidges(m, 3, time, params)
      this.drawMidges(m, 0, time)
    }
    this.drawLogs(mapTex, 1) // above water: over everything rooted below
    if (m && params.insectTrails) this.drawMidgeTrails(m, params) // under the bodies
    drawRanges()
    if (m && params.midgeVisionMode !== 'off') this.drawMidgeRanges(m, params, sim)
    if (m && m.selected >= 0) this.drawMidgeSeen(m)
    if (m) this.drawMidges(m, 1, time) // in the air and on the flowers
    // What the selected creature senses and the forces on it (render/focus.js), on top.
    for (const lines of overlays) if (lines.count) this.drawLines(lines)
    if (hasSel) {
      // Outlined and enlarged so it stands out while keeping its own colour.
      drawBoids(selected, 1, 2, params.boidSize * 2.1, [0, 0], VISION_SELECTED)
      drawBoids(selected, 1, 0, params.boidSize * 1.5)
    }

    this.present(params)
    if (this.inspectorRect) {
      if (midges?.kernel && midges.selected >= 0 && midges.selected < midges.kernel.count) this.drawLeader(midges.kernel, midges.selected)
      else if (hasSel) this.drawLeader(sim, selected)
    }
    gl.bindVertexArray(null)
  }

  /**
   * Carry the clouds (and the caustics, and patterns drifting with the wind)
   * downwind. Integrated per frame (not speed * time) so
   * changing the speed or direction never makes them jump.
   */
  advanceClouds(speed, causticSpeed, time) {
    const dt = Math.max(0, time - (this.cloudTime ?? time))
    this.cloudTime = time
    if (!this.liveWind) {
      this.cloudShift[0] += this.wind[0] * speed * dt
      this.cloudShift[1] += this.wind[1] * speed * dt
    }
    this.windTravel[0] += this.wind[0] * dt
    this.windTravel[1] += this.wind[1] * dt
    // Caustics drift downwind as fast as they used to slide (about causticSpeed tiles per s).
    this.causticShift[0] += this.wind[0] * causticSpeed * dt
    this.causticShift[1] += this.wind[1] * causticSpeed * dt
  }

  /** A one-pixel line from boid `i` of a GPU species to the inspector panel (leaderVS), over the finished frame. */
  drawLeader(kernel, i) {
    const gl = this.gl
    const { program, u } = this.leaderProg
    const r = this.inspectorRect
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCENE) // free once the frame is presented
    gl.bindTexture(gl.TEXTURE_2D, kernel.stateTexture)
    gl.uniform1i(u.u_state, UNIT_SCENE)
    gl.uniform2i(u.u_texel, i & (kernel.texW - 1), i >> kernel.texShift)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform4f(u.u_rect, r.left, r.top, r.right, r.bottom)
    gl.uniform4f(u.u_colour, 0.98 * 0.8, 0.75 * 0.8, 0.25 * 0.8, 0.8) // amber, as the panel's border (premultiplied)
    gl.enable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.LINES, 0, 2)
  }

  /** Cloud-shade, dither and vignette the scene into the (scene-sized) canvas. */
  present(params) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.low[0], this.low[1])
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCENE)
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex)
    const { program, u } = this.postProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2i(u.u_low, this.low[0], this.low[1])
    gl.uniform1f(u.u_levels, params.colorLevels)
    gl.uniform1i(u.u_cloudsOn, params.showClouds ? 1 : 0)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_cell, this.cell)
    gl.uniform3fv(u.u_sunlight, sunlight(params.sunElevation, params.sunBrightness))
    gl.uniform2fv(u.u_cloudShift, this.cloudShift)
    gl.uniform2fv(u.u_wind, this.wind)
    gl.uniform4fv(u.u_windPair, this.windPair)
    gl.uniform1f(u.u_windMix, this.windMix)
    gl.uniform2fv(u.u_windTravel, this.windTravel)
    gl.uniform2fv(u.u_causticShift, this.causticShift)
    gl.activeTexture(gl.TEXTURE0 + UNIT_CLOUDS)
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  /** Silt clouds over the floor, under the fish (see SiltField). */
  drawSilt(silt) {
    if (!silt.texture) return
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + UNIT_SILT)
    gl.bindTexture(gl.TEXTURE_2D, silt.texture)
    const { program, u } = this.siltProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_siltExtent, silt.extent)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Lily pads; with shadowPass, their silhouettes shifted away from the sun. */
  drawPads(pads, sway, time, shadowPass = false) {
    if (!pads.count) return
    const gl = this.gl
    if (pads.version !== this.padVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.padBuf)
      gl.bufferData(gl.ARRAY_BUFFER, pads.data, gl.STATIC_DRAW)
      this.padVersion = pads.version
    }
    const { program, u } = this.padProg
    gl.useProgram(program)
    gl.uniform2f(u.u_resolution, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform1f(u.u_time, time)
    gl.uniform2fv(u.u_swayExtent, sway.extent)
    gl.bindVertexArray(this.padVao)
    gl.uniform2fv(u.u_shift, shadowPass ? this.light.map((l) => l * this.floatHeight * PAD_HEIGHT) : [0, 0])
    gl.uniform2fv(u.u_light, shadowPass ? this.light : [0, 0])
    gl.uniform1f(u.u_elevCell, this.elevCell)
    gl.uniform2fv(u.u_elevDims, this.elevDims)
    gl.uniform1i(u.u_shadowPass, shadowPass ? 1 : 0)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, pads.count)
    gl.bindVertexArray(this.vao)
  }

  /** Bind a GPU species' textures for the midge programs (and the range gene, items, nectar). */
  bindMidges(m) {
    const gl = this.gl
    const k = m.kernel
    const bind = (unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
    }
    bind(UNIT_M_STATE, k.stateTexture)
    bind(UNIT_M_AUX, k.auxTexture)
    bind(UNIT_M_TRAITS, k.traitsTexture)
    bind(UNIT_M_PREV, m.prev ?? k.stateTexture)
    bind(UNIT_M_RANGE, k.genesTexture) // its vision gene (VISION_GENE), read where it lies in each midge's geneTexels
    bind(UNIT_M_ITEMS, m.pond.items.items)
    bind(UNIT_M_NECTAR, m.pond.nectarTexture)
    bind(UNIT_FLOWER_LOOK, m.pond.flowerLook)
    bind(UNIT_M_AUX1, k.aux1Texture)
    bind(UNIT_VERT, k.vertTexture)
  }

  /** The species texture layout uniforms of a midge program. */
  midgeUniforms(u, m) {
    const gl = this.gl
    gl.uniform1i(u.u_mTexW, m.kernel.texW)
    gl.uniform1i(u.u_mTexShift, m.kernel.texShift)
    gl.uniform1i(u.u_mCount, m.kernel.count)
    gl.uniform1i(u.u_mSelected, m.selected)
    gl.uniform1i(u.u_rangeStride, m.kernel.geneTexels)
    gl.uniform1i(u.u_rangeGene, VISION_GENE)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_cell, this.cell)
  }

  /** Midges as points in the insect style (see insectVS for the modes: 0 on the water, 1 flying or perched, 2 shadows; midgeVS 3 ripples). */
  drawMidges(m, mode, time, params) {
    const gl = this.gl
    this.bindMidges(m)
    const { program, u } = this.midgeProg
    gl.useProgram(program)
    this.midgeUniforms(u, m)
    gl.uniform1i(u.u_mode, mode)
    gl.uniform2fv(u.u_light, this.light)
    gl.uniform1f(u.u_elevCell, this.elevCell)
    gl.uniform2fv(u.u_elevDims, this.elevDims)
    gl.uniform1f(u.u_time, time)
    gl.uniform1f(u.u_lowFlight, MIDGE_LOW_FLIGHT)
    gl.uniform1f(u.u_flutterTime, this.flutterClock ?? 0) // real time, frozen while paused (render)
    if (params) gl.uniform1f(u.u_bodyTime, params.insectBodyTime)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.POINTS, 0, m.kernel.count)
  }

  /** Each flying midge's path over this frame, fading out (they show when fast-forwarding). */
  drawMidgeTrails(m, params) {
    if (!m.prev) return
    const gl = this.gl
    this.bindMidges(m)
    const { program, u } = this.midgeTrailProg
    gl.useProgram(program)
    this.midgeUniforms(u, m)
    gl.uniform1f(u.u_maxHop, TRAIL_MAX_SPEED * m.frameTime + 4)
    gl.uniform3fv(u.u_colour, MIDGE_TRAIL)
    gl.uniform1f(u.u_alpha, TRAIL_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.LINES, 0, m.kernel.count * 2)
  }

  /** Midge range rings (all / selected), as fish's: the vision ring program, the radius from each midge's vision gene. */
  drawMidgeRanges(m, params, sim) {
    const gl = this.gl
    const k = m.kernel
    if (params.midgeVisionMode === 'selected' && m.selected < 0) return
    const bind = (unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
    }
    bind(UNIT_STATE, k.stateTexture)
    bind(UNIT_AUX, k.auxTexture)
    bind(UNIT_TRAITS, k.traitsTexture)
    bind(UNIT_M_RANGE, k.genesTexture)
    bind(UNIT_VERT, k.vertTexture) // each midge's height: its ring shrinks near the water
    const ring = (offset, count, color, alpha) => {
      const u = this.use(this.visionProg, k, offset)
      gl.uniform1i(u.u_rangeFromTex, 1)
      gl.uniform1i(u.u_rangeStride, k.geneTexels)
      gl.uniform1i(u.u_rangeGene, VISION_GENE)
      gl.uniform1i(u.u_aliveCheck, 1)
      gl.uniform2f(u.u_heightVision, GROUND_VISION, FULL_VISION_Z) // the lower, the less it sees (species/midges.js)
      gl.uniform1f(u.u_radius, 0)
      gl.uniform1f(u.u_cosHalfFov, -2)
      gl.uniform1f(u.u_sepRatio, 0)
      gl.uniform3fv(u.u_color, color)
      gl.uniform1f(u.u_fill, 0)
      gl.uniform1f(u.u_rim, alpha)
      gl.uniform1i(u.u_rings, 1)
      gl.uniform1f(u.u_band, Math.max(this.cell[0], this.cell[1]))
      gl.uniform1f(u.u_halfSpan, Math.PI)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * S.RING_SEGMENTS, count)
    }
    // Faded by how many are alive, not by the slots (eggs and the dead's
    // empty slots, which only grow): only the living get a ring.
    if (params.midgeVisionMode === 'all') ring(0, k.count, VISION, rangeAlpha(m.alive))
    if (m.selected >= 0) ring(m.selected, 1, VISION_SELECTED, RANGE_SELECTED_ALPHA)
    // The fish's textures back on their units.
    bind(UNIT_STATE, sim.stateTexture)
    bind(UNIT_AUX, sim.auxTexture)
    bind(UNIT_TRAITS, sim.traitsTexture)
    gl.useProgram(this.visionProg.program)
    gl.uniform1i(this.visionProg.u.u_rangeFromTex, 0)
    gl.uniform1i(this.visionProg.u.u_aliveCheck, 0)
  }

  /** What the selected midge sees: lines to the midges in its range, rings round the items it recognises. */
  drawMidgeSeen(m) {
    const gl = this.gl
    this.bindMidges(m)
    gl.bindVertexArray(this.vao)
    let { program, u } = this.seenBoidsProg
    gl.useProgram(program)
    this.midgeUniforms(u, m)
    gl.uniform4fv(u.u_colour, SEEN_MIDGES)
    gl.drawArrays(gl.LINES, 0, m.kernel.count * 2)
    const items = m.pond.items
    if (!items.total) return
    ;({ program, u } = this.seenItemsProg)
    gl.useProgram(program)
    this.midgeUniforms(u, m)
    gl.uniform1i(u.u_itemsW, items.width)
    gl.uniform1i(u.u_itemCount, items.total)
    gl.uniform4fv(u['u_srcColour[0]'], m.seenStyles.colours)
    gl.uniform1fv(u['u_srcRadius[0]'], m.seenStyles.radii)
    gl.drawArrays(gl.LINES, 0, items.total * 24)
  }

  /**
   * Lines in scene pixels ({ data, count, version }: GL_LINES vertices of x,
   * y, premultiplied r, g, b, a): insect motion trails, midge vision rings.
   */
  drawLines(lines) {
    const gl = this.gl
    let set = this.lineSets.get(lines)
    if (!set) {
      set = { buf: gl.createBuffer(), vao: gl.createVertexArray(), version: -1 }
      gl.bindVertexArray(set.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, set.buf)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8)
      this.lineSets.set(lines, set)
    }
    gl.bindVertexArray(set.vao)
    if (lines.version !== set.version) {
      gl.bindBuffer(gl.ARRAY_BUFFER, set.buf)
      gl.bufferData(gl.ARRAY_BUFFER, lines.data.subarray(0, lines.count * 6), gl.DYNAMIC_DRAW)
      set.version = lines.version
    }
    const { program, u } = this.trailProg
    gl.useProgram(program)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_cell, this.cell)
    gl.drawArrays(gl.LINES, 0, lines.count)
    gl.bindVertexArray(this.vao)
  }

  /**
   * Fallen trunks; pass 0 = the part under water, 1 = the part above it,
   * 2 = the shadow of the part above it (into the mask).
   */
  drawLogs(mapTex, pass) {
    if (!mapTex.logCount) return
    const gl = this.gl
    const { program, u } = this.logProg
    gl.useProgram(program)
    gl.uniform2f(u.u_resolution, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_light, pass === 2 ? this.light : [0, 0])
    gl.uniform1f(u.u_elevCell, mapTex.elevCell)
    gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
    gl.uniform1i(u.u_logCount, mapTex.logCount)
    gl.uniform2fv(u.u_seedOffset, mapTex.seedOffset)
    gl.uniform1i(u.u_pass, pass)
    const [lx, ly] = this.light
    const l = Math.hypot(lx, ly, 1)
    gl.uniform3f(u.u_sun, -lx / l, -ly / l, 1 / l)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, mapTex.logCount)
  }

  drawVectors(sim, n, source, scale, ref, offset, low, high, width) {
    const gl = this.gl
    const u = this.use(this.vectorProg, sim)
    gl.uniform1i(u.u_source, source)
    gl.uniform1f(u.u_scale, scale)
    gl.uniform1f(u.u_ref, ref)
    gl.uniform1f(u.u_width, width)
    gl.uniform1f(u.u_offset, offset)
    gl.uniform3fv(u.u_low, low)
    gl.uniform3fv(u.u_high, high)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 9, n)
  }

  /**
   * Water and land never change between frames, so they are rendered once
   * into a cached texture (per map / size / pixel size) and copied with a
   * framebuffer blit afterwards, instead of re-running the noise per pixel.
   */
  /** @param blit copy the cache into the scene (otherwise the water floor pass draws it) */
  drawBackground(mapTex, blit = true) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + UNIT_ELEV)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.elevation)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SDF)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.sdf)
    const key = `${mapTex.version}|${this.low}|${this.viewOffset}|${this.floorKey}`
    if (key !== this.bgKey) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo)
      this.drawStaticWater(mapTex)
      this.bgKey = key
    }
    if (!blit) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo)
      return
    }
    const [w, h] = this.low
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.bgFbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFbo)
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo)
  }

  drawStaticWater(mapTex) {
    const gl = this.gl
    const { program, u } = this.waterProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform1f(u.u_elevCell, mapTex.elevCell)
    gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_landLevel, LAND_LEVEL)
    gl.uniform2fv(u.u_seedOffset, mapTex.seedOffset)
    const [litter, stones, twigs] = this.floorDetails ?? [0, 0, 0]
    gl.uniform1f(u.u_litter, litter)
    gl.uniform1f(u.u_stones, stones)
    gl.uniform1f(u.u_twigs, twigs)
    const [lx, ly] = this.light
    const l = Math.hypot(lx, ly, 1)
    gl.uniform3f(u.u_sun, -lx / l, -ly / l, 1 / l)
    gl.uniform2fv(u.u_light, this.light)
    gl.uniform1f(u.u_waterTint, this.waterTint ?? 0)
    gl.uniform1f(u.u_tintCell, mapTex.tintCell)
    gl.uniform2fv(u.u_tintDims, mapTex.tintDims)
    gl.activeTexture(gl.TEXTURE0 + UNIT_TINT)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.tint)
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  /**
   * The scum pattern is static: render it once per map into a world-space
   * texture (one texel per frond cell) that drawScum() draws fronds from.
   */
  bakeScum(mapTex, amount, vegetation, amongPlants) {
    const gl = this.gl
    const map = mapTex.map
    const key = `${mapTex.version}|${map.width}|${map.height}|${amount}|${vegetation.version}|${amongPlants}`
    if (key === this.scumKey) return
    this.uploadPlantDensity(vegetation, map)
    const w = Math.max(1, Math.ceil(map.width / SCUM_CELL))
    const h = Math.max(1, Math.ceil(map.height / SCUM_CELL))
    gl.deleteTexture(this.scumBakeTex)
    gl.deleteFramebuffer(this.scumBakeFbo)
    // createTexture binds to the active unit: keep it off the units the bake reads.
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM_BAKE)
    this.scumBakeTex = createTexture(gl, gl.RGBA8, w, h)
    this.scumBakeFbo = createFramebuffer(gl, [this.scumBakeTex])
    const { program, u } = this.scumBakeProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scumBakeFbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform1f(u.u_elevCell, mapTex.elevCell)
    gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_landLevel, LAND_LEVEL)
    gl.uniform2fv(u.u_seedOffset, mapTex.seedOffset)
    gl.uniform1f(u.u_amount, amount)
    gl.uniform1f(u.u_amongPlants, amongPlants)
    gl.uniform1i(u.u_plantDensity, UNIT_PLANT_DENSITY)
    gl.uniform1f(u.u_densityCell, PLANT_DENSITY_CELL)
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM_BAKE)
    gl.bindTexture(gl.TEXTURE_2D, this.scumBakeTex)
    this.readScumSpots(w, h)
    this.scumKey = key
  }

  /**
   * How crowded with plants each PLANT_DENSITY_CELL px cell is (0..1: plant
   * bases nearby, blurred), so the scum can keep out of the reeds or crowd
   * into them (params.scumAmongPlants).
   */
  uploadPlantDensity(vegetation, map) {
    const gl = this.gl
    const C = PLANT_DENSITY_CELL
    const w = Math.max(1, Math.ceil(map.width / C))
    const h = Math.max(1, Math.ceil(map.height / C))
    let grid = new Float32Array(w * h)
    for (let i = 0; i < vegetation.count; i++) {
      const o = i * PLANT_STRIDE
      const x = Math.floor(vegetation.data[o] / C)
      const y = Math.floor(vegetation.data[o + 1] / C)
      if (x >= 0 && y >= 0 && x < w && y < h) grid[y * w + x]++
    }
    // Two 3x3 box blurs: about a 5-cell soft footprint per plant.
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += grid[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]
          next[y * w + x] = sum / 9
        }
      }
      grid = next
    }
    const px = new Uint8Array(w * h)
    for (let k = 0; k < px.length; k++) px[k] = Math.round(255 * Math.min(1, grid[k] / PLANT_DENSITY_FULL))
    gl.activeTexture(gl.TEXTURE0 + UNIT_PLANT_DENSITY)
    gl.deleteTexture(this.plantDensityTex)
    this.plantDensityTex = createTexture(gl, gl.R8, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, px)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  }

  /**
   * Where the scum grows, for the CPU side (midges are drawn to it): the
   * centre of every frond cell, read back once per bake.
   */
  readScumSpots(w, h) {
    const gl = this.gl
    const px = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scumBakeFbo)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const spots = []
    for (let i = 0; i < w * h; i++) {
      if (px[i * 4 + 3] === 0) continue
      spots.push(((i % w) + 0.5) * SCUM_CELL, (Math.floor(i / w) + 0.5) * SCUM_CELL)
    }
    this.scumSpots = Float32Array.from(spots)
    this.scumVersion++
  }

  /**
   * The fronds, once per frame: this frame's scum, unshaded, into its own
   * layer. Its shadow (drawScumShadow) and its place in the scene
   * (compositeScum) are read back from the layer.
   */
  drawScum(mapTex, scum, time) {
    const gl = this.gl
    const { program, u } = this.scumProg
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM_BAKE)
    gl.bindTexture(gl.TEXTURE_2D, this.scumBakeTex)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM)
    gl.bindTexture(gl.TEXTURE_2D, scum.texture)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scumLayerFbo)
    gl.viewport(0, 0, this.low[0], this.low[1])
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)
    // The frond cells covering the view, plus room for drift.
    const x0 = Math.floor(this.viewOffset[0] / SCUM_CELL) - SCUM_MARGIN_CELLS
    const y0 = Math.floor(this.viewOffset[1] / SCUM_CELL) - SCUM_MARGIN_CELLS
    const cols = Math.ceil(this.width / SCUM_CELL) + 2 * SCUM_MARGIN_CELLS + 1
    const rows = Math.ceil(this.height / SCUM_CELL) + 2 * SCUM_MARGIN_CELLS + 1
    gl.uniform2i(u.u_firstCell, x0, y0)
    gl.uniform1i(u.u_cols, cols)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform2fv(u.u_seedOffset, mapTex.seedOffset)
    gl.uniform2fv(u.u_cell, this.cell)
    gl.uniform1f(u.u_time, time)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.POINTS, 0, cols * rows)
    gl.enable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM_LAYER)
    gl.bindTexture(gl.TEXTURE_2D, this.scumLayerTex)
  }

  /** The floating scum's shadow into the mask: the layer, shifted away from the sun. */
  drawScumShadow() {
    const gl = this.gl
    const { program, u } = this.scumShadowProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_cell, this.cell)
    gl.uniform2fv(u.u_light, this.light)
    gl.uniform1f(u.u_float, this.floatHeight)
    gl.uniform1f(u.u_elevCell, this.elevCell)
    gl.uniform2fv(u.u_elevDims, this.elevDims)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** This frame's scum into the scene, shaded. */
  compositeScum() {
    const gl = this.gl
    const { program, u } = this.scumCompositeProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Hard shadows: the plants are drawn again (same geometry and sway) into a
   * scene-resolution mask, projected away from the light by their height.
   * Floating scum and lily pads write their own shifted silhouettes into a
   * second channel (they shade only what is below the surface). Every layer then darkens its
   * own pixel by a flat amount where the mask is set, so shadows are
   * pixel-exact and move with the plants and mats.
   */
  drawShadowMask(vegetation, mapTex, sway, scum, pads, time, enabled) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + UNIT_SHADOW)
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFbo)
    gl.viewport(0, 0, this.low[0], this.low[1])
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (enabled) {
      gl.disable(gl.BLEND)
      gl.colorMask(true, false, false, false) // r: plants
      this.drawPlants(vegetation, sway, time, true)
      gl.colorMask(false, false, true, false) // b: trunks
      this.drawLogs(mapTex, 2)
      gl.colorMask(false, true, false, false) // g: floating scum and pads
      this.drawScumShadow()
      this.drawPads(pads, sway, time, true)
      gl.colorMask(true, true, true, true)
      gl.enable(gl.BLEND)
    }
    gl.activeTexture(gl.TEXTURE0 + UNIT_SHADOW)
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
  }

  /**
   * Animated water, full screen over the scene: the floor pass (opaque:
   * cached water + swirl, caustics, refraction and shadows) or the surface
   * pass (ripple glints blended over the fish).
   */
  drawWater(prog, params, sway, mapTex, time, surface) {
    const gl = this.gl
    const { program, u } = prog
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_time, time)
    gl.uniform1i(u.u_cloudsOn, params.showClouds ? 1 : 0)
    gl.uniform2fv(u.u_cloudShift, this.cloudShift)
    gl.uniform2fv(u.u_wind, this.wind)
    gl.uniform4fv(u.u_windPair, this.windPair)
    gl.uniform1f(u.u_windMix, this.windMix)
    gl.uniform2fv(u.u_windTravel, this.windTravel)
    gl.uniform2fv(u.u_causticShift, this.causticShift)
    // The cloud speed doubles as wind strength: stronger wind, livelier ripples.
    gl.uniform1f(u.u_windStrength, 0.4 + 0.6 * Math.min(1, this.windSpeed / 40))
    if (surface) {
      gl.uniform2fv(u.u_swayExtent, sway.extent)
      gl.uniform1f(u.u_rain, this.rain > 0.01 ? this.rain : 0)
      gl.uniform2fv(u.u_cell, this.cell)
      gl.uniform2f(u.u_cloudVel, this.wind[0] * this.windSpeed, this.wind[1] * this.windSpeed)
    }
    gl.bindVertexArray(this.vao)
    if (!surface) gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  /** Darken the cached water/land under the shadow mask. */
  darkenShadows() {
    const gl = this.gl
    const { program, u } = this.shadowProg
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Upload plants sorted by kind (into a data texture), so each kind can be
   * drawn with exactly the vertices it needs (blades * 3, + 6 for a head).
   */
  uploadPlants(vegetation) {
    const gl = this.gl
    const n = vegetation.count
    const src = vegetation.data
    const { slot, starts, counts } = plantSlots(vegetation)
    const rows = Math.max(1, Math.ceil((n * 2) / PLANT_TEX_W))
    const sorted = new Float32Array(rows * PLANT_TEX_W * 4)
    for (let i = 0; i < n; i++) sorted.set(src.subarray(i * PLANT_STRIDE, (i + 1) * PLANT_STRIDE), slot[i] * PLANT_STRIDE)
    gl.deleteTexture(this.plantTex)
    this.plantTex = createTexture(gl, gl.RGBA32F, PLANT_TEX_W, rows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PLANT_TEX_W, rows, gl.RGBA, gl.FLOAT, sorted)
    this.plantBatches = PLANT_KINDS.map((k, i) => ({
      start: starts[i],
      count: counts[i],
      blades: k.blades,
      head: k.head ? 6 : 0,
    })).filter((b) => b.count > 0)
    this.plantVersion = vegetation.version
  }

  drawPlants(vegetation, sway, time, shadowPass = false) {
    if (!vegetation.count) return
    const gl = this.gl
    if (vegetation.version !== this.plantVersion) this.uploadPlants(vegetation)
    const { program, u } = this.plantProg
    gl.useProgram(program)
    gl.uniform2f(u.u_resolution, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform1f(u.u_time, time)
    gl.uniform1f(u.u_pixel, this.cell[0])
    gl.uniform2fv(u.u_swayExtent, sway.extent)
    gl.uniform1i(u.u_shadowPass, shadowPass ? 1 : 0)
    gl.uniform2fv(u.u_light, shadowPass ? this.light : [0, 0])
    gl.uniform2fv(u.u_wind, this.wind)
    gl.uniform4fv(u.u_windPair, this.windPair)
    gl.uniform1f(u.u_windMix, this.windMix)
    gl.activeTexture(gl.TEXTURE0 + UNIT_PLANTS)
    gl.bindTexture(gl.TEXTURE_2D, this.plantTex)
    gl.activeTexture(gl.TEXTURE0 + UNIT_BLOOM)
    gl.bindTexture(gl.TEXTURE_2D, this.nectarTex) // gpu/PondGpu.js: nectar in plant-slot order (r)
    gl.activeTexture(gl.TEXTURE0 + UNIT_FLOWER_LOOK)
    gl.bindTexture(gl.TEXTURE_2D, this.flowerLookTex)
    gl.bindVertexArray(this.vao)
    // Level of detail: at coarse pixel sizes most blades are sub-pixel and
    // indistinguishable, so draw fewer of them.
    const lod = this.pixelSize >= 3 ? 0.5 : this.pixelSize >= 2 ? 0.75 : 1
    for (const b of this.plantBatches) {
      const blades = Math.max(3, Math.round(b.blades * lod))
      const verts = blades * 3 + b.head
      gl.uniform1i(u.u_blades, blades)
      gl.uniform1i(u.u_start, b.start)
      gl.uniform1i(u.u_verts, verts)
      gl.drawArrays(gl.TRIANGLES, 0, b.count * verts)
    }
  }

  destroy() {
    const gl = this.gl
    for (const p of this.programs) gl.deleteProgram(p.program)
    gl.deleteBuffer(this.tuneBuf)
    gl.deleteTexture(this.sceneTex)
    gl.deleteFramebuffer(this.sceneFbo)
    gl.deleteTexture(this.bgTex)
    gl.deleteFramebuffer(this.bgFbo)
    gl.deleteBuffer(this.padBuf)
    gl.deleteVertexArray(this.padVao)
    for (const set of this.lineSets.values()) {
      gl.deleteBuffer(set.buf)
      gl.deleteVertexArray(set.vao)
    }
    gl.deleteTexture(this.plantTex)
    gl.deleteTexture(this.scumBakeTex)
    gl.deleteFramebuffer(this.scumBakeFbo)
    gl.deleteTexture(this.scumLayerTex)
    gl.deleteFramebuffer(this.scumLayerFbo)
    gl.deleteTexture(this.maskTex)
    gl.deleteFramebuffer(this.maskFbo)
    gl.deleteTexture(this.blankTex)
    gl.deleteTexture(this.cloudTex)
    gl.deleteVertexArray(this.vao)
  }
}

