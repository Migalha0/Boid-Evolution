import { LAND_LEVEL } from '../sim/PondMap.js'
import { clearFramebuffers, createFramebuffer, createProgram, createTexture, FADED } from './gl.js'
import { passVS } from './simShaders.js'

/** World px per texel. */
const CELL = 4
/** Elevation above the floor (~20 cm) within which a swimming fish stirs up silt. */
const STIR_HEIGHT = 0.08

// Settle and spread: the cloud thins out as it sinks and widens, and is
// carried along by the fish wakes (sway field).
const settleFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform sampler2D u_sway;
uniform vec2 u_swayExtent;
uniform float u_cell;
uniform float u_keep;
uniform float u_blend;
uniform float u_carry; // px of drift per unit of wake push
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(u_prev, 0));
  vec2 world = gl_FragCoord.xy * u_cell;
  vec2 push = texture(u_sway, world / u_swayExtent).xy;
  vec2 uv = (gl_FragCoord.xy - push * u_carry / u_cell) / size;
  vec2 t = 1.0 / size;
  float c = texture(u_prev, uv).r;
  float avg = (texture(u_prev, uv + vec2(t.x, 0.0)).r + texture(u_prev, uv - vec2(t.x, 0.0)).r
    + texture(u_prev, uv + vec2(0.0, t.y)).r + texture(u_prev, uv - vec2(0.0, t.y)).r) * 0.25;
  o = vec4(mix(c, avg, u_blend) * u_keep, 0.0, 0.0, 1.0);
}
`

// One point per fish: only fish swimming near the floor stir, the faster and
// the closer to it, the more.
const stirVS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_state;
uniform sampler2D u_traits;
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
uniform int u_texW;
uniform int u_texShift;
uniform vec2 u_extent;
uniform float u_pointSize;
uniform float u_maxSpeed;
out float v_amount;
const float LAND = ${LAND_LEVEL.toFixed(4)};
void main() {
  ivec2 c = ivec2(gl_VertexID & (u_texW - 1), gl_VertexID >> u_texShift);
  vec4 s = texelFetch(u_state, c, 0);
  float swim = texelFetch(u_traits, c, 0).y;
  float floorE = texture(u_elev, (s.xy / u_elevCell + 0.5) / u_elevDims).r;
  float above = (1.0 - swim) * clamp(LAND - floorE, 0.0, LAND); // elevation above the floor
  v_amount = (1.0 - smoothstep(0.0, ${STIR_HEIGHT.toFixed(3)}, above)) * min(1.0, length(s.zw) / u_maxSpeed);
  gl_Position = v_amount > 0.0 ? vec4(s.xy / u_extent * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = u_pointSize;
}
`
const stirFS = /* glsl */ `#version 300 es
precision highp float;
in float v_amount;
uniform float u_strength;
out vec4 o;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0) discard;
  o = vec4(v_amount * (1.0 - r) * u_strength, 0.0, 0.0, 0.0);
}
`

/**
 * Silt stirred up from the pond floor (R16F density, world space). Fish
 * swimming close to the bottom kick up small brown clouds that are carried by
 * the wakes, spread and settle back over a few seconds, so how deep a fish
 * swims shows on the water.
 */
export class SiltField {
  constructor(gl) {
    this.gl = gl
    this.settleProg = createProgram(gl, passVS, settleFS)
    this.stirProg = createProgram(gl, stirVS, stirFS)
    gl.useProgram(this.settleProg.program)
    gl.uniform1i(this.settleProg.u.u_prev, 0)
    gl.uniform1i(this.settleProg.u.u_sway, 1)
    gl.useProgram(this.stirProg.program)
    gl.uniform1i(this.stirProg.u.u_state, 0)
    gl.uniform1i(this.stirProg.u.u_traits, 1)
    gl.uniform1i(this.stirProg.u.u_elev, 2)
    this.vao = gl.createVertexArray()
    this.textures = []
    this.fbos = []
    this.dims = [0, 0]
    this.cur = 0
  }

  resize(width, height) {
    const w = Math.max(1, Math.ceil(width / CELL))
    const h = Math.max(1, Math.ceil(height / CELL))
    if (w === this.dims[0] && h === this.dims[1]) return
    this.free()
    const gl = this.gl
    for (let i = 0; i < 2; i++) {
      const tex = createTexture(gl, gl.R16F, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this.textures.push(tex)
      this.fbos.push(createFramebuffer(gl, [tex]))
    }
    this.dims = [w, h]
    this.cur = 0
    this.zero = true
    this.idle = 0
  }

  get texture() {
    return this.textures[this.cur]
  }

  get extent() {
    return [this.dims[0] * CELL, this.dims[1] * CELL]
  }

  /**
   * @param params siltAmount: how much silt a fish kicks up; siltSettle: seconds
   *   for a cloud to settle back (to ~1/3)
   */
  update(sim, sway, mapTex, dt, params) {
    if (!this.textures.length) return
    const gl = this.gl
    // Nothing stirring it (no fish): the silt only settles. Once settled to
    // nothing it is cleared to 0 and left alone until a fish stirs it again.
    if (!sim.count || !(params.siltAmount > 0)) {
      if (this.zero) return
      this.idle += dt
      if (Math.exp(-this.idle / Math.max(0.1, params.siltSettle)) < FADED) {
        clearFramebuffers(gl, this.fbos)
        this.zero = true
        return
      }
    } else {
      this.idle = 0
      this.zero = false
    }
    const next = 1 - this.cur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[next])
    gl.viewport(0, 0, this.dims[0], this.dims[1])
    gl.bindVertexArray(this.vao)

    gl.disable(gl.BLEND)
    const s = this.settleProg.u
    gl.useProgram(this.settleProg.program)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, sway.texture)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.cur])
    gl.uniform2fv(s.u_swayExtent, sway.extent)
    gl.uniform1f(s.u_cell, CELL)
    gl.uniform1f(s.u_keep, Math.exp(-dt / Math.max(0.1, params.siltSettle)))
    gl.uniform1f(s.u_blend, 1 - Math.exp(-6 * dt))
    gl.uniform1f(s.u_carry, 25 * dt)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    if (sim.count && params.siltAmount > 0) {
      const u = this.stirProg.u
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(this.stirProg.program)
      gl.bindTexture(gl.TEXTURE_2D, sim.stateTexture)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, sim.traitsTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, mapTex.elevation)
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1f(u.u_elevCell, mapTex.elevCell)
      gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
      gl.uniform1i(u.u_texW, sim.texW)
      gl.uniform1i(u.u_texShift, sim.texShift)
      gl.uniform2fv(u.u_extent, this.extent)
      gl.uniform1f(u.u_pointSize, 14 / CELL)
      gl.uniform1f(u.u_maxSpeed, params.maxSpeed)
      gl.uniform1f(u.u_strength, params.siltAmount * 8 * dt) // frame-rate independent
      gl.drawArrays(gl.POINTS, 0, sim.count)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    }

    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
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
    this.gl.deleteProgram(this.settleProg.program)
    this.gl.deleteProgram(this.stirProg.program)
    this.gl.deleteVertexArray(this.vao)
  }
}
