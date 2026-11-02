/** Small WebGL2 helpers shared by the simulation and the renderer. */

export function createProgram(gl, vsSrc, fsSrc) {
  const p = gl.createProgram()
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p))
  }
  const u = {}
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(p, i).name
    u[name] = gl.getUniformLocation(p, name)
  }
  return { program: p, u }
}

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    if (gl.isContextLost()) throw new Error('WebGL context lost')
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)}  ${l}`)
      .join('\n')
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s) + '\n' + numbered)
  }
  return s
}

/** Point-sampled immutable texture (sim data is always read with texelFetch). */
export function createTexture(gl, internalFormat, width, height) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

export function createFramebuffer(gl, textures) {
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  textures.forEach((t, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)
  })
  gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16))
  return fb
}

/** Power-of-two texture dims holding `capacity` (a power of two) texels, as square as possible. */
export function texDims(capacity) {
  const log = Math.log2(capacity)
  const w = 1 << Math.ceil(log / 2)
  return [w, capacity / w]
}

export function nextPow2(n) {
  return 1 << Math.ceil(Math.log2(Math.max(1, n)))
}

/**
 * Upload RGBA32F items [start, start + data.length / 4) into a texture laid out
 * row-major with width texW. At most three texSubImage2D calls.
 */
export function uploadRange(gl, tex, texW, start, data) {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  let i = start
  let off = 0
  let left = data.length / 4
  const put = (x, y, w, h) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.FLOAT, data, off * 4)
    off += w * h
    i += w * h
    left -= w * h
  }
  const x0 = i % texW
  if (x0 !== 0 && left > 0) put(x0, Math.floor(i / texW), Math.min(left, texW - x0), 1)
  const full = Math.floor(left / texW)
  if (full > 0) put(0, i / texW, texW, full)
  if (left > 0) put(0, i / texW, left, 1)
}

/**
 * Non-blocking GPU -> CPU reads of RGBA32F framebuffer regions through pixel
 * pack buffers and fences. Call poll() once per frame.
 */
export class Readback {
  constructor(gl) {
    this.gl = gl
    this.pending = []
  }

  read(fbo, attachment, x, y, w, h, callback) {
    const gl = this.gl
    const bytes = w * h * 16
    const pbo = gl.createBuffer()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    gl.readBuffer(attachment)
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, 0)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    this.pending.push({ pbo, sync, bytes, callback })
  }

  poll() {
    const gl = this.gl
    const ready = []
    this.pending = this.pending.filter((r) => {
      if (gl.getSyncParameter(r.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return true
      const out = new Float32Array(r.bytes / 4)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.pbo)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      gl.deleteSync(r.sync)
      gl.deleteBuffer(r.pbo)
      ready.push([r.callback, out])
      return false
    })
    // After the list is settled: a callback may start another read.
    for (const [callback, out] of ready) callback(out)
  }

  destroy() {
    for (const r of this.pending) {
      this.gl.deleteSync(r.sync)
      this.gl.deleteBuffer(r.pbo)
    }
    this.pending = []
  }
}

/** GPU time of a section via EXT_disjoint_timer_query_webgl2; `ms` stays null when unsupported. */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.queries = []
    this.active = null
    this.ms = null
  }

  begin() {
    if (!this.ext || this.queries.length > 4) return
    this.active = this.gl.createQuery()
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active)
  }

  end() {
    if (!this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.queries.push(this.active)
    this.active = null
  }

  poll() {
    const gl = this.gl
    while (this.queries.length) {
      const q = this.queries[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
      if (!disjoint) this.ms = this.ms == null ? ms : this.ms * 0.9 + ms * 0.1
      gl.deleteQuery(q)
      this.queries.shift()
    }
  }

  destroy() {
    for (const q of this.queries) this.gl.deleteQuery(q)
    this.queries = []
  }
}
