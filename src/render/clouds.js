/** Cloud noise texture size (texels per tile). */
const SIZE = 256

/**
 * A tileable fBm noise texture (R8, bilinear, repeating) for cloud shadows.
 * Generated once on the CPU; the post pass scrolls two layers of it with the
 * wind and thresholds the sum into hard-edged shadows.
 */
export function createCloudTexture(gl) {
  const data = new Uint8Array(SIZE * SIZE)
  const octaves = [
    { cells: 4, amp: 0.55 },
    { cells: 8, amp: 0.27 },
    { cells: 16, amp: 0.13 },
    { cells: 32, amp: 0.05 },
  ].map((o) => ({ ...o, lattice: Float32Array.from({ length: o.cells * o.cells }, Math.random) }))
  const smooth = (t) => t * t * (3 - 2 * t)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = 0
      for (const { cells, amp, lattice } of octaves) {
        // Value noise on a lattice that wraps, so the texture tiles seamlessly.
        const fx = (x / SIZE) * cells
        const fy = (y / SIZE) * cells
        const ix = Math.floor(fx)
        const iy = Math.floor(fy)
        const tx = smooth(fx - ix)
        const ty = smooth(fy - iy)
        const at = (i, j) => lattice[(j % cells) * cells + (i % cells)]
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx
        const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx
        v += (top + (bottom - top) * ty) * amp
      }
      data[y * SIZE + x] = Math.round(Math.min(1, v) * 255)
    }
  }
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SIZE, SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, data)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  return tex
}
