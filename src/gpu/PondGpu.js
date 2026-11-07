import { ItemSources } from './boids/ItemSources.js'
import { createFramebuffer, createProgram, createTexture } from './gl.js'
import { HEADER, passVS } from './simShaders.js'
import { PLANT, PLANT_KINDS, PLANT_STRIDE, headColours, plantSlots } from '../sim/Vegetation.js'

/** Nectar texture width (one texel per plant, in plant-slot order: Vegetation plantSlots); the flower look has two per plant. */
export const NECTAR_W = 2048
/** Shelter grid: px per cell, and plants per cell that block the wind fully. */
export const SHELTER_CELL = 16
const SHELTER_FULL = 8
/** Most scum spots kept as items (sampled evenly from the mat: fronds sit every few px). */
const MAX_SCUM_SPOTS = 4000
/** Floats per lily pad in `pads.data` (x, y, radius first). */
const PAD_STRIDE = 8
/** Item sources (ItemSources order): what a sense's `source` index means. */
export const SOURCE = { purple: 0, yellow: 1, scum: 2, pads: 3, cattail: 4 }

// Flowers: nectar per plant slot, (nectar 0..1, state, regrown, quota):
// state 0 open, 1 closed (drunk dry, refilling), > 1 resting (state - 1 s
// left); quota < -1 marks a plant without a flower. Sips (u_drunk, energy,
// summed by additive blending) come off first; a drained flower closes; a
// closed one refills over u_regrow s; after about u_cycle refills it rests
// about u_dormancy s, each on its own count.
const flowerFS = /* glsl */ `${HEADER}
uniform sampler2D u_nectar;
uniform sampler2D u_drunk;
uniform float u_dt;
uniform float u_time;
uniform float u_meals;
uniform float u_regrow;
uniform float u_cycle;
uniform float u_dormancy;
out vec4 o;
float rand(vec2 p, float k) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + k * 37.719 + u_time * 0.618) * 43758.5453); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 n = texelFetch(u_nectar, c, 0);
  if (n.a < -1.5) { o = n; return; }
  float nectar = max(0.0, n.r - texelFetch(u_drunk, c, 0).r / max(u_meals, 1e-3));
  float st = n.g;
  float regrown = n.b;
  float quota = n.a;
  vec2 p = vec2(c);
  if (st == 0.0 && nectar <= 1e-3) { nectar = 0.0; st = 1.0; }
  if (st > 1.0) {
    st = max(1.0, st - u_dt);
  } else if (st == 1.0 || nectar < 1.0) {
    float add = min(u_dt / max(u_regrow, 0.1), 1.0 - nectar);
    nectar += add;
    if (nectar >= 1.0) { nectar = 1.0; st = 0.0; }
    if (u_cycle > 0.0) {
      if (quota < 0.0) { quota = u_cycle * (0.5 + rand(p, 1.0)); regrown = rand(p, 2.0) * quota; }
      regrown += add;
      if (regrown >= quota) {
        nectar = 0.0;
        st = 1.0 + u_dormancy * (0.7 + 0.6 * rand(p, 3.0));
        regrown = 0.0;
        quota = u_cycle * (0.5 + rand(p, 4.0));
      }
    }
  }
  o = vec4(nectar, st, regrown, quota);
}
`

// Sips: one point per boid of a species that eats; one perched on a flower
// (aux[u_modeChannel] == u_eatMode, the flower's plant slot in aux[u_idChannel])
// adds u_sip energy at that flower's texel.
const drinkVS = /* glsl */ `${HEADER}
uniform sampler2D u_aux;
uniform int u_count;
uniform int u_modeChannel;
uniform int u_idChannel;
uniform float u_eatMode;
uniform ivec2 u_target;
void main() {
  gl_PointSize = 1.0;
  vec4 a = texelFetch(u_aux, coordOf(gl_VertexID), 0);
  if (gl_VertexID >= u_count || a[u_modeChannel] != u_eatMode) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int slot = int(a[u_idChannel]);
  vec2 t = (vec2(slot % u_target.x, slot / u_target.x) + 0.5) / vec2(u_target);
  gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
}
`
const drinkFS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_sip;
out vec4 o;
void main() { o = vec4(u_sip, 0.0, 0.0, 1.0); }
`

/**
 * The pond as the boids sense it, on the GPU: the item sources (purple and
 * yellow flowers by plant slot, scum, lily pads), flower nectar and its
 * cycle (a texture the plant renderer reads too), each flower's colours
 * (flowerLook: fresh and withered, which midges see and the renderer draws),
 * the sips of feeding boids,
 * and wind shelter (plant cover and trunks). Rebuilt when the plants, pads or
 * scum change.
 */
export class PondGpu {
  constructor(gl, map, pads) {
    gl.getExtension('EXT_color_buffer_float') // nectar and sips are float targets
    this.gl = gl
    this.map = map
    this.pads = pads
    this.items = new ItemSources(gl)
    this.flowerProg = createProgram(gl, passVS, flowerFS)
    this.drinkProg = createProgram(gl, drinkVS, drinkFS)
    gl.useProgram(this.flowerProg.program)
    gl.uniform1i(this.flowerProg.u.u_nectar, 0)
    gl.uniform1i(this.flowerProg.u.u_drunk, 1)
    gl.useProgram(this.drinkProg.program)
    gl.uniform1i(this.drinkProg.u.u_aux, 0)
    this.nectar = null
    this.flowerLook = null
    this.colourVariation = 1 // params.flowerVariation (Vegetation headColours)
    this.lookKey = ''
    this.cur = 0
    this.shelter = null
    this.shelterDims = [1, 1]
    this.key = ''
    this.scumPoints = new Float32Array(0)
    this.scumVersion = 0
    this.vao = gl.createVertexArray()
  }

  get nectarTexture() {
    return this.nectar?.tex[this.cur] ?? null
  }

  /** World positions of scum fronds (renderer readback), sampled down to MAX_SCUM_SPOTS. */
  setScum(points) {
    const n = points.length / 2
    const step = Math.max(1, n / MAX_SCUM_SPOTS)
    const kept = new Float32Array(Math.floor(n / step) * 2)
    for (let i = 0; i < kept.length / 2; i++) {
      const j = Math.floor(i * step) * 2
      kept[i * 2] = points[j]
      kept[i * 2 + 1] = points[j + 1]
    }
    this.scumPoints = kept
    this.scumVersion++
  }

  /** Rebuild items, nectar and shelter if the plants, pads or scum changed. */
  sync() {
    const { map, pads, gl } = this
    const veg = map.vegetation
    const key = `${map.width}x${map.height}|${map.view}|${veg.version}|${pads.version}|${this.scumVersion}|${map.logVersion}`
    if (key === this.key || !map.width) {
      if (map.width) this.bakeLook()
      return
    }
    const plantsChanged = !this.key || this.plantVersion !== veg.version || this.mapSize !== `${map.width}x${map.height}`
    this.key = key
    const W = map.width
    const H = map.height
    const { slot } = plantSlots(veg)
    const purple = []
    const yellow = []
    const cattail = []
    const sw = Math.max(1, Math.ceil(W / SHELTER_CELL))
    const sh = Math.max(1, Math.ceil(H / SHELTER_CELL))
    const cover = new Float32Array(sw * sh)
    for (let i = 0; i < veg.count; i++) {
      const o = i * PLANT_STRIDE
      const x = veg.data[o]
      const y = veg.data[o + 1]
      cover[Math.min(sh - 1, Math.max(0, Math.floor(y / SHELTER_CELL))) * sw + Math.min(sw - 1, Math.max(0, Math.floor(x / SHELTER_CELL)))]++
      const kind = veg.data[o + 4]
      if (kind !== PLANT.PICKERELWEED && kind !== PLANT.IRIS && kind !== PLANT.CATTAIL) continue
      // The head (flower, cattail spike) sits at the tip of the central blade.
      const reach = PLANT_KINDS[kind].length[1] * veg.data[o + 2] * 0.8
      const rot = veg.data[o + 3]
      const fx = x + Math.cos(rot) * reach
      const fy = y + Math.sin(rot) * reach
      // Off screen (a blade leaning out of view, or a window made smaller
      // than the world): no food out there to keep midges out of view.
      if (map.insideView(fx, fy) < 0) continue
      ;(kind === PLANT.PICKERELWEED ? purple : kind === PLANT.IRIS ? yellow : cattail).push(fx, fy, slot[i])
    }
    const scum = new Float32Array((this.scumPoints.length / 2) * 3)
    for (let i = 0; i < this.scumPoints.length / 2; i++) scum.set([this.scumPoints[i * 2], this.scumPoints[i * 2 + 1], i], i * 3)
    const padPts = new Float32Array(pads.count * 3)
    for (let i = 0; i < pads.count; i++) padPts.set([pads.data[i * PAD_STRIDE], pads.data[i * PAD_STRIDE + 1], i], i * 3)
    this.items.set([Float32Array.from(purple), Float32Array.from(yellow), scum, padPts, Float32Array.from(cattail)], W, H)

    // Nectar: full for every flower, kept as it is while the plants are the same.
    if (plantsChanged) {
      this.plantVersion = veg.version
      this.mapSize = `${W}x${H}`
      const rows = Math.max(1, Math.ceil(veg.count / NECTAR_W))
      const init = new Float32Array(NECTAR_W * rows * 4)
      for (let s = 0; s < NECTAR_W * rows; s++) init.set([1, 0, 0, -2], s * 4)
      for (const list of [purple, yellow]) for (let k = 2; k < list.length; k += 3) init[list[k] * 4 + 3] = -1
      this.freeNectar()
      const tex = [0, 1].map(() => createTexture(gl, gl.RGBA32F, NECTAR_W, rows))
      for (const t of tex) {
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NECTAR_W, rows, gl.RGBA, gl.FLOAT, init)
      }
      const drunk = createTexture(gl, gl.RGBA16F, NECTAR_W, rows)
      this.nectar = { tex, rows, fbo: tex.map((t) => createFramebuffer(gl, [t])), drunk, drunkFbo: createFramebuffer(gl, [drunk]) }
      this.cur = 0
    }
    this.bakeLook()

    // Shelter from the wind: plant cover, and trunks block it fully.
    const shelter = new Float32Array(sw * sh)
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const k = j * sw + i
        const near = map.logs.length ? map.logClearance((i + 0.5) * SHELTER_CELL, (j + 0.5) * SHELTER_CELL, SHELTER_CELL) : null
        shelter[k] = near && near.gap < SHELTER_CELL * 0.5 ? 1 : Math.min(1, cover[k] / SHELTER_FULL)
      }
    }
    gl.deleteTexture(this.shelter)
    this.shelter = createTexture(gl, gl.R32F, sw, sh)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RED, gl.FLOAT, shelter)
    this.shelterDims = [sw, sh]
  }

  /**
   * Each plant's head colours, fresh and withered, side by side per slot
   * (Vegetation headColours, by colourVariation): plantVS draws the head
   * between them by its nectar, and midges see that same colour. Baked again
   * only when the plants or the variation change.
   */
  bakeLook() {
    const veg = this.map.vegetation
    const key = `${veg.version}|${this.colourVariation}`
    if (key === this.lookKey) return
    this.lookKey = key
    const gl = this.gl
    const { slot } = plantSlots(veg)
    const rows = Math.max(1, Math.ceil(veg.count / NECTAR_W))
    const look = new Uint8Array(NECTAR_W * 2 * rows * 4)
    for (let i = 0; i < veg.count; i++) {
      const c = headColours(veg, i, this.colourVariation)
      if (!c) continue
      look.set([...c.fresh.map((v) => Math.round(v * 255)), 255, ...c.withered.map((v) => Math.round(v * 255)), 255], slot[i] * 8)
    }
    gl.deleteTexture(this.flowerLook)
    this.flowerLook = createTexture(gl, gl.RGBA8, NECTAR_W * 2, rows)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NECTAR_W * 2, rows, gl.RGBA, gl.UNSIGNED_BYTE, look)
  }

  /** The flower pass: sips off (from the last drink()), refills and rests; then the sips are cleared. */
  updateFlowers(dt, params, time) {
    const N = this.nectar
    if (!N) return
    const gl = this.gl
    const u = this.flowerProg.u
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.useProgram(this.flowerProg.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, N.fbo[1 - this.cur])
    gl.viewport(0, 0, NECTAR_W, N.rows)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, N.tex[this.cur])
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, N.drunk)
    gl.uniform1f(u.u_dt, dt)
    gl.uniform1f(u.u_time, time)
    gl.uniform1f(u.u_meals, params.flowerNectar)
    gl.uniform1f(u.u_regrow, params.flowerRegrow)
    gl.uniform1f(u.u_cycle, params.flowerRefills)
    gl.uniform1f(u.u_dormancy, params.flowerDormancy)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.cur = 1 - this.cur
    gl.bindFramebuffer(gl.FRAMEBUFFER, N.drunkFbo)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
  }

  /**
   * Sips of the boids of `kernel` perched on flowers (its definition's `eats`:
   * mode and id channels, the eating mode, energy per s from the params),
   * added up by blending.
   */
  drink(kernel, dt, params) {
    const N = this.nectar
    const eats = kernel.def.eats
    if (!N || !eats || !kernel.count) return
    const gl = this.gl
    const u = this.drinkProg.u
    gl.bindVertexArray(this.vao)
    gl.useProgram(this.drinkProg.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, N.drunkFbo)
    gl.viewport(0, 0, NECTAR_W, N.rows)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, kernel.auxTexture)
    gl.uniform1i(u.u_texW, kernel.texW)
    gl.uniform1i(u.u_texShift, kernel.texShift)
    gl.uniform1i(u.u_count, kernel.count)
    gl.uniform1i(u.u_modeChannel, eats.modeChannel)
    gl.uniform1i(u.u_idChannel, eats.idChannel)
    gl.uniform1f(u.u_eatMode, eats.mode)
    gl.uniform2i(u.u_target, NECTAR_W, N.rows)
    gl.uniform1f(u.u_sip, eats.rate(params) * dt)
    gl.drawArrays(gl.POINTS, 0, kernel.count)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
  }

  freeNectar() {
    const N = this.nectar
    if (!N) return
    const gl = this.gl
    for (const t of [...N.tex, N.drunk]) gl.deleteTexture(t)
    for (const f of [...N.fbo, N.drunkFbo]) gl.deleteFramebuffer(f)
    this.nectar = null
  }

  destroy() {
    const gl = this.gl
    this.freeNectar()
    this.items.destroy()
    gl.deleteTexture(this.shelter)
    gl.deleteTexture(this.flowerLook)
    gl.deleteProgram(this.flowerProg.program)
    gl.deleteProgram(this.drinkProg.program)
    gl.deleteVertexArray(this.vao)
  }
}
