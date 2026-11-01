import { createFramebuffer, createProgram, createTexture } from './gl.js'
import { passVS } from './simShaders.js'

/** World px per texel. */
const CELL = 6

const decayFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform float u_keep;
out vec4 o;
void main() {
  o = texelFetch(u_prev, ivec2(gl_FragCoord.xy), 0) * u_keep;
}
`

// One point per boid, positioned straight from the simulation state texture.
const splatVS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_state;
uniform int u_texW;
uniform int u_texShift;
uniform vec2 u_extent;
uniform float u_pointSize;
uniform float u_maxSpeed;
out vec2 v_vel;
void main() {
  int i = gl_VertexID;
  vec4 s = texelFetch(u_state, ivec2(i & (u_texW - 1), i >> u_texShift), 0);
  v_vel = s.zw / u_maxSpeed;
  // No y flip: texel row 0 = world y 0, so plants sample it with uv = world / extent.
  gl_Position = vec4(s.xy / u_extent * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_pointSize;
}
`

// Push = away from the boid + along its velocity, fading to the edge.
const splatFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_vel;
uniform float u_strength;
out vec4 o;
void main() {
  vec2 off = vec2(gl_PointCoord.x * 2.0 - 1.0, 1.0 - gl_PointCoord.y * 2.0);
  float r = length(off);
  if (r > 1.0) discard;
  float f = (1.0 - r) * (1.0 - r);
  vec2 away = r > 1e-3 ? off / r : vec2(0.0);
  o = vec4((away * 0.8 + v_vel * 0.7) * f * u_strength, 0.0, 0.0);
}
`

/**
 * Low-res GPU field of how much the water (and the plants in it) is being
 * pushed by passing boids. Each frame: decay the previous field, then
 * additively splat one point per boid. Plants sample it at their base in the
 * vertex shader and bend accordingly. Cost: two tiny passes, zero CPU work.
 */
export class SwayField {
  constructor(gl) {
    this.gl = gl
    this.decayProg = createProgram(gl, passVS, decayFS)
    this.splatProg = createProgram(gl, splatVS, splatFS)
    gl.useProgram(this.splatProg.program)
    gl.uniform1i(this.splatProg.u.u_state, 0)
    gl.useProgram(this.decayProg.program)
    gl.uniform1i(this.decayProg.u.u_prev, 0)
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
      const tex = createTexture(gl, gl.RG16F, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this.textures.push(tex)
      this.fbos.push(createFramebuffer(gl, [tex]))
    }
    this.dims = [w, h]
    this.cur = 0
  }

  get texture() {
    return this.textures[this.cur]
  }

  get extent() {
    return [this.dims[0] * CELL, this.dims[1] * CELL]
  }

  /**
   * @param params wakeRadius: px of water a fish disturbs; wakeFade: rate (1/s)
   *   the disturbance settles; wakeStrength: push per second; maxSpeed
   */
  update(sim, dt, params) {
    if (!this.textures.length) return
    const gl = this.gl
    const next = 1 - this.cur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[next])
    gl.viewport(0, 0, this.dims[0], this.dims[1])
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)

    gl.disable(gl.BLEND)
    gl.useProgram(this.decayProg.program)
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.cur])
    gl.uniform1f(this.decayProg.u.u_keep, Math.exp(-params.wakeFade * dt))
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    if (sim.count) {
      const { u } = this.splatProg
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(this.splatProg.program)
      gl.bindTexture(gl.TEXTURE_2D, sim.stateTexture)
      gl.uniform1i(u.u_texW, sim.texW)
      gl.uniform1i(u.u_texShift, sim.texShift)
      gl.uniform2fv(u.u_extent, this.extent)
      gl.uniform1f(u.u_pointSize, (2 * params.wakeRadius) / CELL)
      gl.uniform1f(u.u_maxSpeed, params.maxSpeed)
      gl.uniform1f(u.u_strength, params.wakeStrength * dt) // frame-rate independent accumulation
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
    this.gl.deleteProgram(this.decayProg.program)
    this.gl.deleteProgram(this.splatProg.program)
    this.gl.deleteVertexArray(this.vao)
  }
}
