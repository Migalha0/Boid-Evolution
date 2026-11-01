import { createFramebuffer, createProgram, createTexture } from '../gpu/gl.js'
import { SCUM_CELL } from '../gpu/ScumField.js'
import { INSECT_STRIDE } from '../sim/Insects.js'
import { PAD_STRIDE } from '../sim/LilyPads.js'
import { LAND_LEVEL } from '../sim/PondMap.js'
import { MAX_KINDS, PLANT_KINDS, PLANT_STRIDE } from '../sim/Vegetation.js'
import { createCloudTexture } from './clouds.js'
import * as S from './shaders.js'

const VEL_LOW = [0.7, 0.8, 0.82]
const VEL_HIGH = [0.95, 0.6, 0.3]
const ACC_LOW = [0.6, 0.4, 0.75]
const ACC_HIGH = [0.9, 0.4, 0.55]
const VISION = [0.75, 0.85, 0.85]
const VISION_SELECTED = [0.95, 0.8, 0.45]
/** Lily pads float lower than the scum mats: their shadow offset, relative to the scum's. */
const PAD_HEIGHT = 0.275

/**
 * Params -> the shaders' `Tunables` uniform block (TUNE in shaders.js): seven
 * vec4s, in slot order (the last one padded). Each entry turns panel units into the shader's.
 */
const TUNABLES = [
  (p) => 1 - p.shadowDarkness, // SHADOW
  (p) => 1 - p.plantSelfShadow, // PLANT_SELF_SHADE
  (p) => p.murkSurface,
  (p) => p.murkDeep,
  (p) => 1 / p.cloudSize, // CLOUD_SCALE
  (p) => 0.65 - 0.4 * p.cloudCover, // CLOUD_COVER threshold
  (p) => p.cloudSoftness, // CLOUD_EDGE
  (p) => 1 - p.cloudDarkness, // CLOUD_SHADE
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
  (p) => p.logMurk,
  (p) => p.deepFade,
  (p) => p.siltOpacity,
  (p) => (p.showPlants ? p.sludgeAmount : 0), // SLUDGE
]
const TUNE_BINDING = 0

// Texture units: sim state/aux are bound once per frame and shared by all programs.
const UNIT_STATE = 0
const UNIT_AUX = 1
const UNIT_FIELD = 2
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
/** Frond cells drawn beyond each side of the view: fronds drift up to 30 px (ScumField). */
const SCUM_MARGIN_CELLS = 12

/** Unit vector the wind blows towards; direction in degrees clockwise from north (screen up). */
export function windVector(direction) {
  const a = (direction * Math.PI) / 180
  return [Math.sin(a), -Math.cos(a)]
}

/**
 * Shadow offset per px of height, away from the sun.
 * @param azimuth sun direction in degrees, clockwise from north (screen up)
 * @param elevation sun height above the horizon in degrees
 */
export function lightVector(azimuth, elevation) {
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
    this.fieldProg = createProgram(gl, S.fieldVS, S.fieldFS)
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
    this.insectProg = createProgram(gl, S.insectVS, S.insectFS)
    this.shadeProg = createProgram(gl, S.fieldVS, S.shadeFS)
    this.logProg = createProgram(gl, S.logVS, S.logFS)
    this.siltProg = createProgram(gl, S.fieldVS, S.siltFS)
    this.postProg = createProgram(gl, S.fieldVS, S.postFS)
    this.programs = [
      this.boidProg,
      this.vectorProg,
      this.visionProg,
      this.fieldProg,
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
      this.insectProg,
      this.shadeProg,
      this.logProg,
      this.siltProg,
      this.postProg,
    ]
    // One uniform buffer of look parameters, shared by every program using it.
    this.tuneData = new Float32Array(Math.ceil(TUNABLES.length / 4) * 4)
    this.tuneBuf = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.tuneBuf)
    gl.bufferData(gl.UNIFORM_BUFFER, this.tuneData.byteLength, gl.DYNAMIC_DRAW)
    for (const { program } of this.programs) {
      const block = gl.getUniformBlockIndex(program, 'Tunables')
      if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, block, TUNE_BINDING)
    }
    for (const p of [this.boidProg, this.scumCompositeProg, this.plantProg, this.padProg, this.logProg, this.shadowProg, this.waterFloorProg, this.shadeProg]) {
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
    gl.useProgram(this.boidProg.program)
    gl.uniform1i(this.boidProg.u.u_trunks, UNIT_TRUNKS)
    gl.uniform1i(this.boidProg.u.u_elev, UNIT_ELEV)
    gl.useProgram(this.siltProg.program)
    gl.uniform1i(this.siltProg.u.u_silt, UNIT_SILT)
    gl.uniform1i(this.siltProg.u.u_background, UNIT_BG)
    gl.useProgram(this.logProg.program)
    gl.uniform1i(this.logProg.u.u_logs, UNIT_LOGS)
    gl.uniform1i(this.logProg.u.u_background, UNIT_BG)
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
    gl.useProgram(this.fieldProg.program)
    gl.uniform1i(this.fieldProg.u.u_field, UNIT_FIELD)
    for (const p of [this.waterFloorProg, this.waterSurfaceProg]) {
      gl.useProgram(p.program)
      gl.uniform1i(p.u.u_background, UNIT_BG)
      gl.uniform1i(p.u.u_sdf, UNIT_SDF)
      gl.uniform1i(p.u.u_clouds, UNIT_CLOUDS)
    }
    gl.uniform1i(this.waterSurfaceProg.u.u_sway, UNIT_SWAY)
    // Ripples keep off trunks breaking the surface.
    gl.uniform1i(this.waterSurfaceProg.u.u_sdf, UNIT_SURFACE)
    gl.useProgram(this.shadeProg.program)
    gl.uniform1i(this.shadeProg.u.u_clouds, UNIT_CLOUDS)
    gl.useProgram(this.postProg.program)
    gl.uniform1i(this.postProg.u.u_scene, UNIT_SCENE)
    gl.uniform1i(this.postProg.u.u_clouds, UNIT_CLOUDS)
    gl.activeTexture(gl.TEXTURE0 + UNIT_CLOUDS)
    this.cloudTex = createCloudTexture(gl)
    this.cloudShift = [0, 0]
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
    // Point buffers drawn by the insect program, one per source (midges,
    // dragonflies), made on first use.
    this.pointSets = new Map()
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

    this.viewOffset = [0, 0]
    this.pixelSize = 0
    this.low = [0, 0]
    this.sceneTex = null
    this.sceneFbo = null

    this.fieldTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.fieldVersion = -1
    this.fieldPixels = new Uint8Array(0)
  }

  /** Plant kinds are static: upload their parameters once as uniform arrays. */
  setupPlantKinds() {
    const gl = this.gl
    const shape = new Float32Array(MAX_KINDS * 4)
    const base = new Float32Array(MAX_KINDS * 3)
    const tip = new Float32Array(MAX_KINDS * 3)
    const head = new Float32Array(MAX_KINDS * 4)
    const headColor = new Float32Array(MAX_KINDS * 3)
    const spread = new Float32Array(MAX_KINDS)
    const regional = new Float32Array(MAX_KINDS)
    PLANT_KINDS.forEach((k, i) => {
      shape.set([k.blades, k.length[0], k.length[1], k.width], i * 4)
      base.set(k.base, i * 3)
      tip.set(k.tip, i * 3)
      spread[i] = k.spread
      regional[i] = k.regional ?? 0
      if (k.head) {
        head.set([1, k.head.length, k.head.width, 0], i * 4)
        headColor.set(k.head.color, i * 3)
      }
    })
    const { program, u } = this.plantProg
    gl.useProgram(program)
    gl.uniform4fv(u['u_kindShape[0]'], shape)
    gl.uniform3fv(u['u_kindBase[0]'], base)
    gl.uniform3fv(u['u_kindTip[0]'], tip)
    gl.uniform4fv(u['u_kindHead[0]'], head)
    gl.uniform3fv(u['u_kindHeadColor[0]'], headColor)
    gl.uniform1fv(u['u_kindSpread[0]'], spread)
    gl.uniform1fv(u['u_kindRegional[0]'], regional)
    gl.uniform1i(u.u_sway, UNIT_SWAY)
    gl.uniform1i(u.u_plants, UNIT_PLANTS)
    gl.uniform1i(u.u_bloom, UNIT_BLOOM)
    gl.useProgram(this.padProg.program)
    gl.uniform1i(this.padProg.u.u_sway, UNIT_SWAY)
    gl.uniform1i(this.padProg.u.u_elev, UNIT_ELEV)
    gl.useProgram(this.insectProg.program)
    gl.uniform1i(this.insectProg.u.u_elev, UNIT_ELEV)
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
    // Coarse light map for the midges (see drawShade).
    gl.deleteTexture(this.shadeTex)
    gl.deleteFramebuffer(this.shadeFbo)
    this.shadeDims = [Math.ceil(w / S.SHADE_CELL), Math.ceil(h / S.SHADE_CELL)]
    this.shadeTex = createTexture(gl, gl.RGBA32F, ...this.shadeDims)
    this.shadeFbo = createFramebuffer(gl, [this.shadeTex])
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
  render(sim, field, mapTex, vegetation, sway, scum, silt, pads, insects, dragonflies, params, selected, time) {
    const gl = this.gl
    const n = sim.count
    const px = params.pixelSize
    this.ensureScene(px)
    this.light = lightVector(params.sunAzimuth, params.sunElevation)
    this.wind = windVector(params.windDirection)
    this.floatHeight = params.floatHeight
    this.elevCell = mapTex.elevCell
    this.elevDims = mapTex.elevDims
    // The floor's sludge is sized and murked by the panel: re-render the cached background when those change.
    this.floorKey = `${params.murkSurface}|${params.murkDeep}|${params.showPlants ? params.sludgeAmount : 0}|${params.floorLitter}|${params.floorStones}|${params.floorTwigs}`
    this.floorDetails = [params.floorLitter, params.floorStones, params.floorTwigs]
    TUNABLES.forEach((f, i) => (this.tuneData[i] = f(params)))
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.tuneBuf)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.tuneData)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, TUNE_BINDING, this.tuneBuf)
    this.advanceClouds(params.cloudSpeed, time)
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
    if (params.showPlants) {
      this.bakeScum(mapTex)
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
    if (field.visible) this.drawField(field)
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

    if (params.visionMode !== 'off') {
      const drawVision = (offset, count, color, fill, rim, rings) => {
        const u = this.use(this.visionProg, sim, offset)
        gl.uniform1f(u.u_radius, params.perception)
        gl.uniform1f(u.u_cosHalfFov, cosHalfFov)
        gl.uniform1f(u.u_sepRatio, sepRatio)
        gl.uniform3fv(u.u_color, color)
        gl.uniform1f(u.u_fill, fill)
        gl.uniform1f(u.u_rim, rim)
        gl.uniform1i(u.u_rings, rings ? 1 : 0)
        gl.uniform1f(u.u_band, 2 * Math.max(this.cell[0], this.cell[1]))
        gl.uniform1f(u.u_halfSpan, Math.min(Math.PI, ((params.fov * Math.PI) / 180) / 2 + 0.05))
        gl.drawArraysInstanced(gl.TRIANGLES, 0, rings ? 12 * S.RING_SEGMENTS : 6, count)
      }
      if (params.visionMode === 'all') {
        // Fade with density so thousands of overlapping discs don't saturate.
        // Rims only: a faint fill over thousands of discs costs more than it shows.
        const k = Math.min(1, Math.max(0.12, 1200 / n))
        drawVision(0, n, VISION, 0, 0.07 * k, true)
      }
      if (hasSel) drawVision(selected, 1, VISION_SELECTED, 0.1, 0.8, false)
    }

    const drawBoids = (offset, count, mode, size, shift = [0, 0], tint = [1, 1, 1]) => {
      const u = this.use(this.boidProg, sim, offset)
      gl.uniform1f(u.u_size, size)
      gl.uniform2fv(u.u_shift, shift)
      gl.uniform1i(u.u_mode, mode)
      gl.uniform3fv(u.u_tint, tint)
      gl.uniform1f(u.u_maxForce, params.maxForce)
      gl.uniform1f(u.u_pixel, this.cell[0])
      gl.uniform2fv(u.u_light, this.light)
      gl.uniform1f(u.u_elevCell, mapTex.elevCell)
      gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
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
    const midges = params.showInsects && insects.points > 0
    const hunters = params.showInsects && params.showDragonflies
    if (midges && params.shadowDarkness > 0) this.drawInsects(insects, 2, time)
    if (hunters && params.shadowDarkness > 0) this.drawInsects(dragonflies, 2, time)
    if (params.siltOpacity > 0) this.drawSilt(silt)
    drawBoids(0, n, 0, params.boidSize)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SWAY)
    gl.bindTexture(gl.TEXTURE_2D, sway.texture)
    if (waterMotion) this.drawWater(this.waterSurfaceProg, params, sway, mapTex, time, true)
    if (params.showPlants) {
      // Surface layers, over the fish: scum, then lily pads, then emergent plants.
      this.compositeScum()
      this.drawPads(pads, sway, time)
      if (midges) this.drawInsects(insects, 0, time) // on the water, under overhanging plants
      if (hunters) this.drawInsects(dragonflies, 0, time) // their clutches
      this.drawPlants(vegetation, sway, time)
    } else {
      if (midges) this.drawInsects(insects, 0, time)
      if (hunters) this.drawInsects(dragonflies, 0, time)
    }
    this.drawLogs(mapTex, 1) // above water: over everything rooted below
    if (midges) this.drawInsects(insects, 1, time) // in the air and on the flowers
    if (hunters) this.drawInsects(dragonflies, 1, time)
    if (hasSel) {
      // Outlined and enlarged so it stands out while keeping its own colour.
      drawBoids(selected, 1, 2, params.boidSize * 2.1, [0, 0], VISION_SELECTED)
      drawBoids(selected, 1, 0, params.boidSize * 1.5)
    }

    if (this.shadeWanted) this.drawShade(params)
    this.present(params)
    gl.bindVertexArray(null)
  }

  /**
   * The coarse light map (shadeFS) into shadeFbo, for the engine to read back.
   * Its texels cover `shadeCell` world px each, from the view's top-left.
   */
  drawShade(params) {
    const gl = this.gl
    const { program, u } = this.shadeProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadeFbo)
    gl.viewport(0, 0, ...this.shadeDims)
    gl.disable(gl.BLEND)
    gl.useProgram(program)
    gl.uniform2f(u.u_uvScale, 1, 1)
    gl.uniform2f(u.u_uvOffset, 0, 0)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform1i(u.u_cloudsOn, params.showClouds ? 1 : 0)
    gl.uniform2fv(u.u_cloudShift, this.cloudShift)
    gl.uniform2fv(u.u_wind, this.wind)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
    this.shadeWanted = false
    this.shadeReady = true
  }

  get shadeCell() {
    return [this.width / this.shadeDims[0], this.height / this.shadeDims[1]]
  }

  /**
   * Carry the clouds downwind. Integrated per frame (not speed * time) so
   * changing the speed or direction never makes them jump.
   */
  advanceClouds(speed, time) {
    const dt = Math.max(0, time - (this.cloudTime ?? time))
    this.cloudTime = time
    this.cloudShift[0] += this.wind[0] * speed * dt
    this.cloudShift[1] += this.wind[1] * speed * dt
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
    gl.uniform2fv(u.u_cloudShift, this.cloudShift)
    gl.uniform2fv(u.u_wind, this.wind)
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

  /** The GPU buffer and vertex array for a point source ({ data, points, version }), made on first use. */
  pointSet(source) {
    let set = this.pointSets.get(source)
    if (set) return set
    const gl = this.gl
    set = { buf: gl.createBuffer(), vao: gl.createVertexArray(), version: -1 }
    gl.bindVertexArray(set.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, set.buf)
    for (let loc = 0; loc < 2; loc++) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSECT_STRIDE * 4, loc * 16)
    }
    gl.bindVertexArray(this.vao)
    this.pointSets.set(source, set)
    return set
  }

  /**
   * Points in the insect style: the midges (with their eggs and ripples) or
   * the dragonflies, each from its own buffer. See insectVS for the modes: 0
   * on the water, 1 flying or perched, 2 shadows.
   */
  drawInsects(source, mode, time) {
    const gl = this.gl
    const set = this.pointSet(source)
    gl.bindVertexArray(set.vao)
    if (source.version !== set.version) {
      gl.bindBuffer(gl.ARRAY_BUFFER, set.buf)
      gl.bufferData(gl.ARRAY_BUFFER, source.data, gl.DYNAMIC_DRAW)
      set.version = source.version
    }
    const { program, u } = this.insectProg
    gl.useProgram(program)
    gl.uniform1i(u.u_mode, mode)
    gl.uniform2f(u.u_view, this.width, this.height)
    gl.uniform2fv(u.u_viewOffset, this.viewOffset)
    gl.uniform2fv(u.u_cell, this.cell)
    gl.uniform2fv(u.u_light, this.light)
    gl.uniform1f(u.u_elevCell, this.elevCell)
    gl.uniform2fv(u.u_elevDims, this.elevDims)
    gl.uniform1f(u.u_time, time)
    gl.drawArrays(gl.POINTS, 0, source.points)
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
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
  }

  /**
   * The scum pattern is static: render it once per map into a world-space
   * texture (one texel per frond cell) that drawScum() draws fronds from.
   */
  bakeScum(mapTex) {
    const gl = this.gl
    const map = mapTex.map
    const key = `${mapTex.version}|${map.width}|${map.height}`
    if (key === this.scumKey) return
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
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.enable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCUM_BAKE)
    gl.bindTexture(gl.TEXTURE_2D, this.scumBakeTex)
    this.readScumSpots(w, h)
    this.scumKey = key
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
    // The cloud speed doubles as wind strength: stronger wind, livelier ripples.
    gl.uniform1f(u.u_windStrength, 0.4 + 0.6 * Math.min(1, params.cloudSpeed / 40))
    if (surface) gl.uniform2fv(u.u_swayExtent, sway.extent)
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
    const counts = new Array(PLANT_KINDS.length).fill(0)
    for (let i = 0; i < n; i++) counts[src[i * PLANT_STRIDE + 4]]++
    const starts = []
    let acc = 0
    for (const c of counts) {
      starts.push(acc)
      acc += c
    }
    const cursor = [...starts]
    const rows = Math.max(1, Math.ceil((n * 2) / PLANT_TEX_W))
    const sorted = new Float32Array(rows * PLANT_TEX_W * 4)
    // Where each plant went, for the bloom texture.
    this.plantSlot = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const k = src[i * PLANT_STRIDE + 4]
      this.plantSlot[i] = cursor[k]
      sorted.set(src.subarray(i * PLANT_STRIDE, (i + 1) * PLANT_STRIDE), cursor[k]++ * PLANT_STRIDE)
    }
    gl.deleteTexture(this.plantTex)
    this.plantTex = createTexture(gl, gl.RGBA32F, PLANT_TEX_W, rows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PLANT_TEX_W, rows, gl.RGBA, gl.FLOAT, sorted)
    const bloomRows = Math.max(1, Math.ceil(n / PLANT_TEX_W))
    this.bloomSorted = new Float32Array(bloomRows * PLANT_TEX_W)
    gl.deleteTexture(this.bloomTex)
    this.bloomTex = createTexture(gl, gl.R32F, PLANT_TEX_W, bloomRows)
    this.bloomVersion = -1
    this.plantBatches = PLANT_KINDS.map((k, i) => ({
      start: starts[i],
      count: counts[i],
      blades: k.blades,
      head: k.head ? 6 : 0,
    })).filter((b) => b.count > 0)
    this.plantVersion = vegetation.version
  }

  /** How much nectar each flower holds (vegetation.bloom), in plant order. */
  uploadBloom(vegetation) {
    const gl = this.gl
    const sorted = this.bloomSorted
    const slot = this.plantSlot
    const bloom = vegetation.bloom
    for (let i = 0; i < slot.length; i++) sorted[slot[i]] = bloom[i]
    gl.activeTexture(gl.TEXTURE0 + UNIT_BLOOM)
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PLANT_TEX_W, sorted.length / PLANT_TEX_W, gl.RED, gl.FLOAT, sorted)
    this.bloomVersion = vegetation.bloomVersion
  }

  drawPlants(vegetation, sway, time, shadowPass = false) {
    if (!vegetation.count) return
    const gl = this.gl
    if (vegetation.version !== this.plantVersion) this.uploadPlants(vegetation)
    if (vegetation.bloomVersion !== this.bloomVersion) this.uploadBloom(vegetation)
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
    gl.activeTexture(gl.TEXTURE0 + UNIT_PLANTS)
    gl.bindTexture(gl.TEXTURE_2D, this.plantTex)
    gl.activeTexture(gl.TEXTURE0 + UNIT_BLOOM)
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex)
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

  drawField(field) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + UNIT_FIELD)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    if (field.version !== this.fieldVersion) {
      const size = field.cols * field.rows * 4
      if (this.fieldPixels.length !== size) this.fieldPixels = new Uint8Array(size)
      field.toRGBA(this.fieldPixels)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, field.cols, field.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.fieldPixels)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      this.fieldVersion = field.version
    }
    const fp = this.fieldProg
    gl.useProgram(fp.program)
    const extentX = field.cols * field.cellSize
    const extentY = field.rows * field.cellSize
    gl.uniform2f(fp.u.u_uvScale, this.width / extentX, this.height / extentY)
    gl.uniform2f(fp.u.u_uvOffset, this.viewOffset[0] / extentX, this.viewOffset[1] / extentY)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  destroy() {
    const gl = this.gl
    for (const p of this.programs) gl.deleteProgram(p.program)
    gl.deleteBuffer(this.tuneBuf)
    gl.deleteTexture(this.fieldTex)
    gl.deleteTexture(this.sceneTex)
    gl.deleteFramebuffer(this.sceneFbo)
    gl.deleteTexture(this.bgTex)
    gl.deleteFramebuffer(this.bgFbo)
    gl.deleteBuffer(this.padBuf)
    gl.deleteVertexArray(this.padVao)
    for (const set of this.pointSets.values()) {
      gl.deleteBuffer(set.buf)
      gl.deleteVertexArray(set.vao)
    }
    gl.deleteTexture(this.plantTex)
    gl.deleteTexture(this.bloomTex)
    gl.deleteTexture(this.scumBakeTex)
    gl.deleteFramebuffer(this.scumBakeFbo)
    gl.deleteTexture(this.scumLayerTex)
    gl.deleteFramebuffer(this.scumLayerFbo)
    gl.deleteTexture(this.shadeTex)
    gl.deleteFramebuffer(this.shadeFbo)
    gl.deleteTexture(this.maskTex)
    gl.deleteFramebuffer(this.maskFbo)
    gl.deleteTexture(this.blankTex)
    gl.deleteTexture(this.cloudTex)
    gl.deleteVertexArray(this.vao)
  }
}

