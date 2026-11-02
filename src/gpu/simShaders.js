// GPGPU passes. Every boid is one texel; textures are power-of-two wide so
// index <-> texel conversion is a mask and a shift.

/** Sort keys pack (cell << ID_BITS) | boid index into one uint. */
export const ID_BITS = 18
/** Grid cells must stay below this; the top cell id marks padding (key 0xFFFFFFFF). */
export const MAX_CELLS = (1 << (32 - ID_BITS)) - 1

export const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform int u_texW;
uniform int u_texShift;
ivec2 coordOf(int i) { return ivec2(i & (u_texW - 1), i >> u_texShift); }
int indexOf(ivec2 c) { return (c.y << u_texShift) | c.x; }
const uint ID_MASK = ${(1 << ID_BITS) - 1}u;
`

// Fullscreen triangle; the viewport decides which texels get computed.
export const passVS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`

// 1. Sort key: (cell, boid index). Padding slots get the max key so they sort
// last. A species with modes (u_modeChannel >= 0) files every boid not in flight
// (aux[channel] != 0: perched, dead, gone) under cell MAX_CELLS, after every
// real cell: still updated, but no one's neighbour.
export const hashFS = /* glsl */ `${HEADER}
uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform int u_modeChannel;
uniform int u_count;
uniform vec2 u_cellSize;
uniform ivec2 u_grid;
out uvec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = indexOf(c);
  if (i >= u_count) { o = uvec4(0xFFFFFFFFu); return; }
  vec2 p = texelFetch(u_state, c, 0).xy;
  if (u_modeChannel >= 0 && texelFetch(u_aux, c, 0)[u_modeChannel] != 0.0) { o = uvec4(uint(${(1 << (32 - 18)) - 1}) << ${ID_BITS}u | uint(i)); return; }
  ivec2 cell = clamp(ivec2(floor(p / u_cellSize)), ivec2(0), u_grid - 1);
  o = uvec4(uint(cell.y * u_grid.x + cell.x) << ${ID_BITS}u | uint(i));
}
`

// 2. Up to SORT_FUSE consecutive bitonic compare-and-swap steps of stage u_k
// (j = u_j, u_j/2, ...) in one pass: the steps only mix the 2^steps keys
// whose indices differ in those bits, so each texel loads that group and runs
// the steps in registers. Passes, not bandwidth, are what a sort costs here.
// Keys are unique (they hold the index).
export const SORT_FUSE = 3
export const sortFS = /* glsl */ `${HEADER}
uniform usampler2D u_keys;
uniform int u_k;
uniform int u_j;
uniform int u_steps;
out uvec4 o;
const int G = ${1 << SORT_FUSE};
void main() {
  int i = indexOf(ivec2(gl_FragCoord.xy));
  int low = u_j >> (u_steps - 1); // smallest step
  int bits = (u_j << 1) - low;    // the index bits the steps act on
  int base = i & ~bits;
  int n = 1 << u_steps;
  uint v[G];
  for (int a = 0; a < G; a++) if (a < n) v[a] = texelFetch(u_keys, coordOf(base + a * low), 0).x;
  bool up = (i & u_k) == 0;
  for (int t = ${SORT_FUSE - 1}; t >= 0; t--) {
    if (t >= u_steps) continue;
    int d = 1 << t;
    for (int a = 0; a < G; a++) {
      if (a >= n || (a & d) != 0) continue;
      uint x = v[a];
      uint y = v[a | d];
      if ((x > y) == up) { v[a] = y; v[a | d] = x; }
    }
  }
  int me = (i & bits) / low;
  uint r = v[0];
  for (int a = 1; a < G; a++) if (a == me) r = v[a];
  o = uvec4(r);
}
`

// 2b. The last bitonic steps (j < SORT_BLOCK) of a stage, all in one pass:
// each texel loads its whole block and runs those steps in registers. With
// u_k <= SORT_BLOCK it runs every stage up to u_k, i.e. sorts each block.
// Small blocks win: bigger ones spill the register array and get slower.
export const SORT_BLOCK = 4
export const sortLocalFS = /* glsl */ `${HEADER}
uniform usampler2D u_keys;
uniform int u_k;
out uvec4 o;
const int B = ${SORT_BLOCK};
const int LOG_B = ${Math.log2(SORT_BLOCK)};
void main() {
  int i = indexOf(ivec2(gl_FragCoord.xy));
  int base = i & ~(B - 1);
  uint v[B];
  for (int a = 0; a < B; a++) v[a] = texelFetch(u_keys, coordOf(base + a), 0).x;
  for (int s = 1; s <= LOG_B; s++) {
    // Stage of size 2^s: all of them while sorting blocks, else only the last.
    if (u_k <= B ? (1 << s) > u_k : s < LOG_B) continue;
    int k = u_k <= B ? 1 << s : u_k;
    for (int t = s - 1; t >= 0; t--) {
      int j = 1 << t;
      for (int a = 0; a < B; a++) {
        int b = a ^ j;
        if (b < a) continue;
        uint x = v[a];
        uint y = v[b];
        if ((x < y) != (((base + a) & k) == 0)) { v[a] = y; v[b] = x; }
      }
    }
  }
  uint r = v[0];
  for (int a = 1; a < B; a++) if (a == i - base) r = v[a];
  o = uvec4(r);
}
`

// 2'. Rank sort, for small flocks: in far fewer passes than bitonic, each
// boid counts the keys smaller than its own. The scan is split into chunks
// (one fragment per boid and chunk) so there are enough threads to hide
// memory latency; the scatter pass adds the chunks up.
export const RANK_CHUNKS = 32
export const rankFS = /* glsl */ `${HEADER}
uniform usampler2D u_keys;
uniform int u_count;
uniform int u_chunk; // boids per chunk
out uvec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int chunk = c.x >> u_texShift;
  ivec2 own = ivec2(c.x & (u_texW - 1), c.y);
  if (indexOf(own) >= u_count) { o = uvec4(0u); return; }
  uint a = texelFetch(u_keys, own, 0).x;
  int j0 = chunk * u_chunk;
  int j1 = min(j0 + u_chunk, u_count);
  uint r = 0u;
  for (int j = j0; j < j1; j++) r += uint(texelFetch(u_keys, coordOf(j), 0).x < a);
  o = uvec4(r, 0u, 0u, 0u);
}
`

// One point per boid, written to texel = its rank: state and key in sorted order.
export const scatterVS = /* glsl */ `${HEADER}
uniform usampler2D u_ranks;
uniform sampler2D u_state;
uniform usampler2D u_keys;
uniform vec2 u_dims;
flat out vec4 v_state;
flat out uint v_key;
void main() {
  ivec2 own = coordOf(gl_VertexID);
  v_key = texelFetch(u_keys, own, 0).x;
  uint r = 0u;
  for (int k = 0; k < ${RANK_CHUNKS}; k++) r += texelFetch(u_ranks, ivec2(own.x + (k << u_texShift), own.y), 0).x;
  v_state = texelFetch(u_state, own, 0);
  gl_Position = vec4((vec2(coordOf(int(r))) + 0.5) / u_dims * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

export const scatterFS = /* glsl */ `#version 300 es
precision highp float;
flat in vec4 v_state;
flat in uint v_key;
layout(location = 0) out vec4 o;
layout(location = 1) out uvec4 o_key;
void main() {
  o = v_state;
  o_key = uvec4(v_key);
}
`

// 3. Copy state into sorted order so a cell's boids are contiguous in memory,
// next to its key (the index says where the rest of the boid's data lives).
export const gatherFS = /* glsl */ `${HEADER}
uniform usampler2D u_keys;
uniform sampler2D u_state;
uniform int u_count;
layout(location = 0) out vec4 o;
layout(location = 1) out uvec4 o_key;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (indexOf(c) >= u_count) { o = vec4(0.0); o_key = uvec4(0xFFFFFFFFu); return; }
  uint key = texelFetch(u_keys, c, 0).x;
  o = texelFetch(u_state, coordOf(int(key & ID_MASK)), 0);
  o_key = uvec4(key);
}
`

// 3'. Between sorts: the state again in the last sort's order (fresh
// positions, the same order; the search allows for the drift since).
export const regatherFS = /* glsl */ `${HEADER}
uniform usampler2D u_sortedKeys;
uniform sampler2D u_state;
uniform int u_count;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (indexOf(c) >= u_count) { o = vec4(0.0); return; }
  o = texelFetch(u_state, coordOf(int(texelFetch(u_sortedKeys, c, 0).x & ID_MASK)), 0);
}
`

// 6. One point per boid: the update's results (sorted order) back to the
// boid's own texel.
export const writeBackVS = (aux) => /* glsl */ `${HEADER}
uniform sampler2D u_nextState;
uniform sampler2D u_nextAux;
${aux > 1 ? 'uniform sampler2D u_nextAux1;' : ''}
uniform usampler2D u_sortedKeys;
uniform vec2 u_dims;
flat out vec4 v_state;
flat out vec4 v_aux;
${aux > 1 ? 'flat out vec4 v_aux1;' : ''}
void main() {
  ivec2 k = coordOf(gl_VertexID);
  v_state = texelFetch(u_nextState, k, 0);
  v_aux = texelFetch(u_nextAux, k, 0);
  ${aux > 1 ? 'v_aux1 = texelFetch(u_nextAux1, k, 0);' : ''}
  ivec2 own = coordOf(int(texelFetch(u_sortedKeys, k, 0).x & ID_MASK));
  gl_Position = vec4((vec2(own) + 0.5) / u_dims * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

/** Write-back for a species with `aux` aux textures (1 or 2). */
export const writeBackFS = (aux) => /* glsl */ `#version 300 es
precision highp float;
flat in vec4 v_state;
flat in vec4 v_aux;
${aux > 1 ? 'flat in vec4 v_aux1;' : ''}
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;
${aux > 1 ? 'layout(location = 2) out vec4 o_aux1;' : ''}
void main() {
  o_state = v_state;
  o_aux = v_aux;
  ${aux > 1 ? 'o_aux1 = v_aux1;' : ''}
}
`

// 4. Per cell: [start, end) range in the sorted array, via binary search.
export const cellsFS = /* glsl */ `${HEADER}
uniform usampler2D u_sortedKeys;
uniform int u_count;
uniform int u_cells;
uniform int u_cellTexW;
out uvec4 o;
uint keyAt(int k) { return texelFetch(u_sortedKeys, coordOf(k), 0).x >> ${ID_BITS}u; }
int lowerBound(uint key, int lo) {
  int hi = u_count;
  while (lo < hi) {
    int mid = (lo + hi) >> 1;
    if (keyAt(mid) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
void main() {
  int cell = int(gl_FragCoord.y) * u_cellTexW + int(gl_FragCoord.x);
  if (cell >= u_cells) { o = uvec4(0u); return; }
  int start = lowerBound(uint(cell), 0);
  int end = lowerBound(uint(cell + 1), start);
  o = uvec4(uint(start), uint(end), 0u, 0u);
}
`
