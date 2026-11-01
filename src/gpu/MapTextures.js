import { LOGS } from '../render/shaders.js'
import { LOG_STRIDE, MAX_LOG_SEGMENTS, packLogs } from '../sim/Logs.js'
import { ELEV_CELL, SDF_CELL } from '../sim/PondMap.js'
import { createFramebuffer, createProgram, createTexture } from './gl.js'
import { passVS } from './simShaders.js'

/** Furthest trunk distance stored in the trunk map (px). */
const TRUNK_FAR = 256

// One texel per world px: r = top of the highest trunk there (-1 = none),
// g = distance to the nearest trunk side (capped), so fish can be hidden under
// trunks and the simulation can skip trunk checks far from any, each with one
// lookup.
const trunkBakeFS = /* glsl */ `#version 300 es
precision highp float;
${LOGS}
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  o = vec4(logTopAt(p), logDistance(p, ${TRUNK_FAR.toFixed(1)}), 0.0, 1.0);
}
`

/**
 * GPU copies of the map's elevation and signed-distance grids (R16F,
 * bilinear). Shared by the simulation (shore steering/containment) and the
 * renderer (water depth, shoreline). Re-uploaded only when the map changes.
 * Also the fallen trunks: as a texture for the renderer (3 texels per
 * segment, one row each) and as a uniform array for the simulation, plus the
 * surface SDF that floating things (scum, pads) keep to, and the baked trunk
 * map (see trunkBakeFS). `version` changes whenever anything here does.
 */
export class MapTextures {
  constructor(gl, map) {
    this.gl = gl
    this.map = map
    this.elevation = linearTexture(gl)
    this.sdf = linearTexture(gl)
    this.surface = linearTexture(gl)
    this.logs = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.logs)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.logCount = 0
    /** Segments as vec4[2 * MAX_LOG_SEGMENTS]: (a, b), (ra, rb, za, zb). */
    this.logUniforms = new Float32Array(MAX_LOG_SEGMENTS * 8)
    this.trunkProg = createProgram(gl, passVS, trunkBakeFS)
    this.trunkMap = null
    this.trunkFbo = null
    this.trunkDims = [0, 0]
    this.mapVersion = -1
    this.logVersion = -1
    this.version = -1
  }

  sync() {
    const { gl, map } = this
    if (!map.width || (map.version === this.mapVersion && map.logVersion === this.logVersion)) return
    if (map.version !== this.mapVersion) {
      gl.bindTexture(gl.TEXTURE_2D, this.elevation)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, map.cols, map.rows, 0, gl.RED, gl.FLOAT, map.elevation)
      gl.bindTexture(gl.TEXTURE_2D, this.sdf)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, map.sdfCols, map.sdfRows, 0, gl.RED, gl.FLOAT, map.sdf)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.surface)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, map.sdfCols, map.sdfRows, 0, gl.RED, gl.FLOAT, map.surfaceSdf)
    const data = packLogs(map.logs)
    gl.bindTexture(gl.TEXTURE_2D, this.logs)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, data.length / LOG_STRIDE, 0, gl.RGBA, gl.FLOAT, data)
    this.logCount = map.logs.length
    this.logUniforms.fill(0)
    for (let i = 0; i < this.logCount; i++) this.logUniforms.set(data.subarray(i * LOG_STRIDE, i * LOG_STRIDE + 8), i * 8)
    this.bakeTrunks()
    this.mapVersion = map.version
    this.logVersion = map.logVersion
    this.version++
  }

  bakeTrunks() {
    const { gl, map } = this
    const w = Math.ceil(map.width)
    const h = Math.ceil(map.height)
    gl.activeTexture(gl.TEXTURE0)
    if (w !== this.trunkDims[0] || h !== this.trunkDims[1]) {
      gl.deleteTexture(this.trunkMap)
      gl.deleteFramebuffer(this.trunkFbo)
      this.trunkMap = createTexture(gl, gl.RG16F, w, h)
      this.trunkFbo = createFramebuffer(gl, [this.trunkMap])
      this.trunkDims = [w, h]
    }
    const { program, u } = this.trunkProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trunkFbo)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, this.logs)
    gl.uniform1i(u.u_logs, 0)
    gl.uniform1i(u.u_logCount, this.logCount)
    gl.bindVertexArray(null)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.enable(gl.BLEND)
  }

  /** Elevation samples sit at i * cell: uv = (world / cell + 0.5) / dims. */
  get elevCell() {
    return ELEV_CELL
  }
  get elevDims() {
    return [this.map.cols, this.map.rows]
  }
  /** SDF samples sit at texel centres: uv = world / extent. */
  get sdfExtent() {
    return [this.map.sdfCols * SDF_CELL, this.map.sdfRows * SDF_CELL]
  }
  get sdfCell() {
    return SDF_CELL
  }
  /** Shifts shader noise per map, so each map's scum pattern differs. */
  get seedOffset() {
    return [this.map.seed % 997, Math.floor(this.map.seed / 997) % 991]
  }

  destroy() {
    this.gl.deleteTexture(this.elevation)
    this.gl.deleteTexture(this.sdf)
    this.gl.deleteTexture(this.surface)
    this.gl.deleteTexture(this.logs)
    this.gl.deleteTexture(this.trunkMap)
    this.gl.deleteFramebuffer(this.trunkFbo)
    this.gl.deleteProgram(this.trunkProg.program)
  }
}

function linearTexture(gl) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}
