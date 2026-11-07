import { createFramebuffer, createProgram, createTexture } from './gl.js'
import { passVS } from './simShaders.js'

/** World px per texel: one texel per scum frond (the frond grid spacing). */
export const SCUM_CELL = 3
/** Furthest a frond drifts from where it grew, in px. */
const MAX_DRIFT = 30

// Texel c is the frond that grew at rest position (c + 0.5) * CELL; it holds
// how far that frond has drifted. Fronds are shoved by the fish wake at
// where they are now, and loosely follow their neighbours (so channels
// slowly close up), but nothing pulls them back to where they grew.
const updateFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform sampler2D u_sway;
uniform sampler2D u_sdf; // surface SDF: shore and trunks breaking the surface
uniform vec2 u_swayExtent;
uniform vec2 u_sdfExtent;
uniform float u_cell;
uniform float u_gain;
uniform float u_blend;
uniform float u_max;
out vec4 o;
vec2 at(ivec2 c) {
  return texelFetch(u_prev, clamp(c, ivec2(0), textureSize(u_prev, 0) - 1), 0).xy;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 rest = (vec2(c) + 0.5) * u_cell;
  vec2 d = at(c);
  vec2 avg = (at(c + ivec2(1, 0)) + at(c - ivec2(1, 0)) + at(c + ivec2(0, 1)) + at(c - ivec2(0, 1))) * 0.25;
  vec2 next = mix(d, avg, u_blend) + texture(u_sway, (rest + d) / u_swayExtent).xy * u_gain;
  float l = length(next);
  if (l > u_max) next *= u_max / l;
  // Fronds never wash up onto land or over a trunk.
  if (texture(u_sdf, (rest + next) / u_sdfExtent).r < 1.0) next = d;
  o = vec4(next, 0.0, 1.0);
}
`

/**
 * Drift of the individual pond-scum fronds (px, RG16F, one texel per frond
 * cell). Fish shove fronds aside (via the sway field) and they stay where
 * they were pushed; the scum shader draws each frond as a rigid disc at its
 * rest position plus its drift.
 */
export class ScumField {
  constructor(gl) {
    this.gl = gl
    this.prog = createProgram(gl, passVS, updateFS)
    gl.useProgram(this.prog.program)
    gl.uniform1i(this.prog.u.u_prev, 0)
    gl.uniform1i(this.prog.u.u_sway, 1)
    gl.uniform1i(this.prog.u.u_sdf, 2)
    this.vao = gl.createVertexArray()
    this.textures = []
    this.fbos = []
    this.dims = [0, 0]
    this.cur = 0
    this.mapVersion = -1
  }

  /** @param {import('./SwayField.js').SwayField} sway */
  resize(sway) {
    const [ew, eh] = sway.extent
    const w = Math.max(1, Math.ceil(ew / SCUM_CELL))
    const h = Math.max(1, Math.ceil(eh / SCUM_CELL))
    if (w === this.dims[0] && h === this.dims[1]) return
    this.free()
    const gl = this.gl
    for (let i = 0; i < 2; i++) {
      const tex = createTexture(gl, gl.RG16F, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this.textures.push(tex)
      this.fbos.push(createFramebuffer(gl, [tex]))
    }
    this.dims = [w, h]
    this.cur = 0
    this.still = true
  }

  get texture() {
    return this.textures[this.cur]
  }

  get extent() {
    return [this.dims[0] * SCUM_CELL, this.dims[1] * SCUM_CELL]
  }

  /**
   * @param mapTex fronds stay off its land and trunks; a new map puts every frond back
   * @param params scumDrag: px/s of frond drift per unit of fish push;
   *   scumCohesion: rate (1/s) neighbouring fronds drift together
   */
  update(sway, mapTex, dt, params) {
    if (!this.textures.length) return
    const gl = this.gl
    if (mapTex.version !== this.mapVersion) {
      for (const fbo of this.fbos) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      this.mapVersion = mapTex.version
      this.still = true
    }
    // Every frond where it grew (no drift anywhere) and no wake to shove one:
    // a step would leave all at 0, so skip it.
    if (this.still && sway.zero) return
    this.still = false
    const next = 1 - this.cur
    const { u } = this.prog
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[next])
    gl.viewport(0, 0, this.dims[0], this.dims[1])
    gl.disable(gl.BLEND)
    gl.useProgram(this.prog.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.cur])
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, sway.texture)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, mapTex.surface)
    gl.uniform2fv(u.u_swayExtent, sway.extent)
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_cell, SCUM_CELL)
    gl.uniform1f(u.u_gain, params.scumDrag * dt)
    gl.uniform1f(u.u_blend, 1 - Math.exp(-params.scumCohesion * dt))
    gl.uniform1f(u.u_max, MAX_DRIFT)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.enable(gl.BLEND)
    this.cur = next
  }

  free() {
    for (const t of this.textures) this.gl.deleteTexture(t)
    for (const f of this.fbos) this.gl.deleteFramebuffer(f)
    this.textures = []
    this.fbos = []
  }

  destroy() {
    this.free()
    this.gl.deleteProgram(this.prog.program)
    this.gl.deleteVertexArray(this.vao)
  }
}
