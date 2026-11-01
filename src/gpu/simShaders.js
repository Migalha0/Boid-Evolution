import { MAX_LOG_SEGMENTS } from '../sim/Logs.js'
// GPGPU passes. Every boid is one texel; textures are power-of-two wide so
// index <-> texel conversion is a mask and a shift.

/** Sort keys pack (cell << ID_BITS) | boid index into one uint. */
export const ID_BITS = 18
/** Grid cells must stay below this; the top cell id marks padding (key 0xFFFFFFFF). */
export const MAX_CELLS = (1 << (32 - ID_BITS)) - 1

const HEADER = /* glsl */ `#version 300 es
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

// 1. Sort key: (cell, boid index). Padding slots get the max key so they sort last.
export const hashFS = /* glsl */ `${HEADER}
uniform sampler2D u_state;
uniform int u_count;
uniform vec2 u_cellSize;
uniform ivec2 u_grid;
out uvec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = indexOf(c);
  if (i >= u_count) { o = uvec4(0xFFFFFFFFu); return; }
  vec2 p = texelFetch(u_state, c, 0).xy;
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

// 6. One point per boid: the update's results (sorted order) back to the
// boid's own texel.
export const writeBackVS = /* glsl */ `${HEADER}
uniform sampler2D u_nextState;
uniform sampler2D u_nextAux;
uniform usampler2D u_sortedKeys;
uniform vec2 u_dims;
flat out vec4 v_state;
flat out vec4 v_aux;
void main() {
  ivec2 k = coordOf(gl_VertexID);
  v_state = texelFetch(u_nextState, k, 0);
  v_aux = texelFetch(u_nextAux, k, 0);
  ivec2 own = coordOf(int(texelFetch(u_sortedKeys, k, 0).x & ID_MASK));
  gl_Position = vec4((vec2(own) + 0.5) / u_dims * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

export const writeBackFS = /* glsl */ `#version 300 es
precision highp float;
flat in vec4 v_state;
flat in vec4 v_aux;
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;
void main() {
  o_state = v_state;
  o_aux = v_aux;
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

// 5. Neighbour search + steering + shore avoidance + integration in a single pass (MRT):
//    out0 = (x, y, vx, vy), out1 = (ax, ay, neighbours, tail phase).
// Runs in sorted order (texel k = k-th boid by cell), so neighbouring
// fragments are neighbouring fish reading the same cells; writeBack then puts
// the results back at each boid's own index.
export const updateFS = /* glsl */ `${HEADER}
uniform sampler2D u_aux; // previous aux: w carries the tail-beat phase
uniform sampler2D u_sorted;
uniform usampler2D u_sortedKeys;
uniform usampler2D u_cellTable;
uniform usampler2D u_labels;
uniform sampler2D u_behaviors;
uniform sampler2D u_sdf; // signed distance to shore in px, + water, - land
uniform vec2 u_sdfExtent;
uniform float u_sdfCell;
uniform sampler2D u_traits; // (colour, swim depth as a fraction of the water depth, -, -)
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
uniform float u_landLevel;
// Fallen trunks, 2 vec4 per segment: (ax, ay, bx, by), (ra, rb, za, zb) with
// r the radius in px and z the axis elevation at each end.
uniform vec4 u_logs[${MAX_LOG_SEGMENTS * 2}];
uniform int u_logCount;
uniform sampler2D u_trunkMap; // 1 texel per px: g = distance to the nearest trunk (MapTextures)
uniform float u_logElevPerPx;

uniform int u_count;
uniform vec2 u_world;
uniform vec2 u_rescale;
uniform vec2 u_cellSize;
uniform ivec2 u_grid;
uniform int u_cellTexW;

uniform float u_dt;
uniform float u_perception;
uniform float u_separation;
uniform float u_cosHalfFov;
uniform bool u_fullFov;
uniform float u_minSpeed;
uniform float u_maxSpeed;
uniform float u_maxForce;
uniform int u_maxNeighbors;
uniform int u_scanBudget; // most candidates a boid looks at, so crowds cost a bounded amount
uniform vec3 u_weights; // alignment, cohesion, separation
uniform float u_wallWeight;
uniform float u_beat;      // tail-beat frequency multiplier

uniform bool u_fieldActive;
uniform float u_fieldCell;
uniform ivec2 u_fieldDims;

layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;

float shoreAt(vec2 p) { return texture(u_sdf, p / u_sdfExtent).r; }
vec2 inwardAt(vec2 p) {
  vec2 e = vec2(u_sdfCell, 0.0);
  vec2 g = vec2(shoreAt(p + e.xy) - shoreAt(p - e.xy), shoreAt(p + e.yx) - shoreAt(p - e.yx));
  float l = length(g);
  return l > 1e-5 ? g / l : normalize(u_world * 0.5 - p + 1e-3);
}

// Distance (px) from p to the surface of trunk segment i, for a fish at
// elevation zf, and the direction n away from it. A trunk is only in the way
// where it spans this fish's depth and leaves no room to slip over it (below
// the surface) or under it (above the floor); elsewhere the fish just rises
// or dives past it (swimDepthNear), so it is not blocked (1e5).
const int MAX_NEAR_LOGS = 8;
const float LOG_CLEARANCE = 0.03; // elevation: about half a koi's body height
const float LOG_PASS_RAMP = 14.0; // px from a trunk over which a fish changes depth to pass it
float floorAt(vec2 p) { return texture(u_elev, (p / u_elevCell + 0.5) / u_elevDims).r; }
bool logPassable(float z, float re, float floorE) {
  return u_landLevel - (z + re) > 2.0 * LOG_CLEARANCE || (z - re) - floorE > 2.0 * LOG_CLEARANCE;
}
float logGap(int i, vec2 p, float zf, out vec2 n) {
  vec4 a = u_logs[2 * i];
  vec4 b = u_logs[2 * i + 1];
  vec2 ab = a.zw - a.xy;
  float t = clamp(dot(p - a.xy, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 d = p - (a.xy + ab * t);
  float l = length(d);
  n = l > 1e-4 ? d / l : normalize(vec2(-ab.y, ab.x));
  float r = mix(b.x, b.y, t);
  float z = mix(b.z, b.w, t);
  float re = r * u_logElevPerPx;
  if (abs(zf - z) > re + LOG_CLEARANCE || logPassable(z, re, floorAt(p))) return 1e5;
  return l - r;
}
// The elevation a fish that would swim at zf takes at p: over or under any
// trunk spanning its depth (whichever is the shorter move), easing into it
// over LOG_PASS_RAMP px as the fish nears the trunk.
float swimDepthNear(vec2 p, float zf, float floorE, int near[MAX_NEAR_LOGS], int nearCount) {
  float z0 = zf;
  for (int k = 0; k < nearCount; k++) {
    vec4 a = u_logs[2 * near[k]];
    vec4 b = u_logs[2 * near[k] + 1];
    vec2 ab = a.zw - a.xy;
    float t = clamp(dot(p - a.xy, ab) / dot(ab, ab), 0.0, 1.0);
    float r = mix(b.x, b.y, t);
    float gap = length(p - (a.xy + ab * t)) - r;
    float z = mix(b.z, b.w, t);
    float re = r * u_logElevPerPx;
    float lo = z - re - LOG_CLEARANCE;
    float hi = z + re + LOG_CLEARANCE;
    if (z0 <= lo || z0 >= hi) continue;
    bool over = u_landLevel - hi > LOG_CLEARANCE;
    bool under = lo - floorE > LOG_CLEARANCE;
    if (!over && !under) continue;
    float side = over && (!under || hi - z0 < z0 - lo) ? hi : lo;
    zf = mix(zf, side, 1.0 - smoothstep(0.0, LOG_PASS_RAMP, gap));
  }
  return zf;
}

// What a fish sees as solid: the shore, and the trunks in its way.
float obstacleAt(vec2 p, float zf, int near[MAX_NEAR_LOGS], int nearCount) {
  float d = shoreAt(p);
  vec2 n;
  for (int k = 0; k < nearCount; k++) d = min(d, logGap(near[k], p, zf, n));
  return d;
}

// Reynolds steering: normalize(target) * maxSpeed - v, limited to maxForce.
vec2 steer(vec2 target, vec2 v) {
  float tm = length(target);
  if (tm == 0.0) return vec2(0.0);
  vec2 s = target / tm * u_maxSpeed - v;
  float sm = length(s);
  return sm > u_maxForce ? s * (u_maxForce / sm) : s;
}

// Accumulate one candidate neighbour n = (x, y, vx, vy) seen from pos, heading h.
void consider(vec4 n, vec2 pos, vec2 h, float r2, float sep2, inout int count, inout vec2 al, inout vec2 co, inout vec2 se) {
  vec2 d = n.xy - pos;
  float d2 = dot(d, d);
  if (d2 > r2 || d2 < 1e-8) return; // out of range, or self
  if (!u_fullFov && dot(d, h) < u_cosHalfFov * sqrt(d2)) return;
  count++;
  al += n.zw;
  co += d;
  if (d2 < sep2) se -= d / d2; // closer neighbours push harder
}

// Grid cells, nearest first, out to 2 cells: cells are at least half the
// vision range wide, so that covers it.
const ivec2 CELL_ORDER[25] = ivec2[25](
  ivec2(0, 0), ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1),
  ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2),
  ivec2(2, 1), ivec2(-2, 1), ivec2(2, -1), ivec2(-2, -1),
  ivec2(1, 2), ivec2(-1, 2), ivec2(1, -2), ivec2(-1, -2),
  ivec2(2, 2), ivec2(-2, 2), ivec2(2, -2), ivec2(-2, -2));

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int self = indexOf(c);
  if (self >= u_count) { o_state = vec4(0.0); o_aux = vec4(0.0); return; }
  ivec2 own = coordOf(int(texelFetch(u_sortedKeys, c, 0).x & ID_MASK)); // this boid's own texel

  vec4 s = texelFetch(u_sorted, c, 0);
  vec2 pos = s.xy * u_rescale;
  vec2 vel = s.zw;
  float sp = length(vel);
  vec2 h = sp > 0.0 ? vel / sp : vec2(1.0, 0.0);

  float r2 = u_perception * u_perception;
  float sep2 = u_separation * u_separation;

  int count = 0;
  vec2 al = vec2(0.0);
  vec2 co = vec2(0.0);
  vec2 se = vec2(0.0);

  // Only cells that reach within the vision range, nearest first. Each cell
  // is read starting from a different place per boid, so in a crowd not
  // everyone follows the same few.
  ivec2 cell = clamp(ivec2(floor(pos / u_cellSize)), ivec2(0), u_grid - 1);
  int budget = u_scanBudget;
  for (int o = 0; o < 25 && count < u_maxNeighbors && budget > 0; o++) {
    ivec2 g = cell + CELL_ORDER[o];
    if (any(lessThan(g, ivec2(0))) || any(greaterThanEqual(g, u_grid))) continue;
    vec2 lo = vec2(g) * u_cellSize;
    vec2 gap = max(max(lo - pos, pos - lo - u_cellSize), 0.0);
    if (dot(gap, gap) > r2) continue;
    int cid = g.y * u_grid.x + g.x;
    ivec2 range = ivec2(texelFetch(u_cellTable, ivec2(cid % u_cellTexW, cid / u_cellTexW), 0).xy);
    int len = range.y - range.x;
    int n = min(len, budget);
    budget -= n;
    int k = len > 0 ? self % len : 0;
    for (int j = 0; j < n && count < u_maxNeighbors; j++) {
      consider(texelFetch(u_sorted, coordOf(range.x + k), 0), pos, h, r2, sep2, count, al, co, se);
      if (++k == len) k = 0;
    }
  }

  vec2 acc = vec2(0.0);
  if (count > 0) {
    acc += u_weights.x * steer(al, vel);
    acc += u_weights.y * steer(co, vel);
    acc += u_weights.z * steer(se, vel);
  }

  // Painted regions: label under the boid -> (speedMul, flowX, flowY, _).
  float speedMul = 1.0;
  if (u_fieldActive) {
    ivec2 fc = ivec2(floor(pos / u_fieldCell));
    if (all(greaterThanEqual(fc, ivec2(0))) && all(lessThan(fc, u_fieldDims))) {
      uint label = texelFetch(u_labels, fc, 0).r;
      vec4 b = texelFetch(u_behaviors, ivec2(int(label), 0), 0);
      speedMul = b.x;
      acc += b.yz * u_maxForce;
    }
  }

  float am = length(acc);
  float aLimit = u_maxForce * 2.0;
  if (am > aLimit) acc *= aLimit / am;

  // The fish's elevation: its own depth as a fraction of the water below it.
  float floorE = floorAt(pos);
  float swim = texelFetch(u_traits, own, 0).y;
  float zf = u_landLevel * (1.0 - swim * clamp((u_landLevel - floorE) / u_landLevel, 0.0, 1.0));
  // Trunks within sight that are in the way at this fish's depth.
  int near[MAX_NEAR_LOGS];
  int nearCount = 0;
  // Far from every trunk (one lookup), there is nothing to check.
  ivec2 tc = clamp(ivec2(pos), ivec2(0), textureSize(u_trunkMap, 0) - 1);
  int logCount = texelFetch(u_trunkMap, tc, 0).g < u_perception + 4.0 ? u_logCount : 0;
  for (int i = 0; i < logCount && nearCount < MAX_NEAR_LOGS; i++) {
    vec4 a = u_logs[2 * i];
    vec2 ab = a.zw - a.xy;
    float t = clamp(dot(pos - a.xy, ab) / dot(ab, ab), 0.0, 1.0);
    float r = max(u_logs[2 * i + 1].x, u_logs[2 * i + 1].y);
    if (length(pos - (a.xy + ab * t)) - r < u_perception + 2.0) near[nearCount++] = i;
  }

  // Shore avoidance, added after the clamp so it always wins over flocking.
  // The shore (and trunks in the way) is seen with the same senses as
  // neighbours: rays fanned across the field of view, each sphere-traced
  // through the obstacle distance out to the vision range. Steer towards the
  // clearest water, harder the closer the obstacle ahead.
  const int RAYS = 9;
  float halfFov = u_fullFov ? 3.14159 : acos(u_cosHalfFov);
  vec2 open = vec2(0.0);
  float urgency = 0.0;
  // Nothing solid within sight: every ray is clear, skip them.
  int rays = nearCount == 0 && shoreAt(pos) >= u_perception ? 0 : RAYS;
  for (int i = 0; i < rays; i++) {
    float a = halfFov * ((float(i) + 0.5) / float(RAYS) * 2.0 - 1.0);
    vec2 dir = vec2(h.x * cos(a) - h.y * sin(a), h.x * sin(a) + h.y * cos(a));
    float t = 0.0;
    for (int k = 0; k < 6 && t < u_perception; k++) {
      float d = obstacleAt(clamp(pos + dir * t, vec2(0.0), u_world), zf, near, nearCount);
      if (d < 3.0) break;
      t += max(d, 2.0);
    }
    float clear = min(t / u_perception, 1.0);
    open += dir * clear * clear;
    urgency = max(urgency, (1.0 - clear) * (0.5 + 0.5 * dot(dir, h)));
  }
  if (urgency > 0.0) {
    // Push off whichever is closest, shore or trunk.
    vec2 away = inwardAt(pos);
    float closest = shoreAt(pos);
    for (int k = 0; k < nearCount; k++) {
      vec2 n;
      float g = logGap(near[k], pos, zf, n);
      if (g < closest) { closest = g; away = n; }
    }
    acc += u_wallWeight * urgency * steer(open + away * urgency, vel);
  }

  vel += acc * u_dt;
  float v = length(vel);
  float lo = u_minSpeed * speedMul;
  float hi = u_maxSpeed * speedMul;
  if (v > hi) vel *= hi / v;
  else if (v < lo) vel = (v > 1e-6 ? vel / v : h) * lo;

  // Hard containment: anything reaching the shore is pushed back into the
  // water and slides along it (the outward velocity component is removed).
  const float SKIN = 1.5;
  // Two projection steps resolve concave corners where one is not enough.
  pos = clamp(pos + vel * u_dt, vec2(SKIN), u_world - SKIN);
  for (int k = 0; k < 2; k++) {
    float d = shoreAt(pos);
    if (d >= SKIN) break;
    vec2 inward = inwardAt(pos);
    pos += inward * (SKIN - d);
    vel -= inward * min(dot(vel, inward), 0.0);
  }
  // Trunks in the way at this depth are solid too.
  for (int k = 0; k < nearCount; k++) {
    vec2 n;
    float g = logGap(near[k], pos, zf, n);
    if (g < SKIN) {
      pos += n * (SKIN - g);
      vel -= n * min(dot(vel, n), 0.0);
    }
  }

  o_state = vec4(pos, vel);
  // Where it swims now (rising over or diving under trunks), as a fraction of
  // the water depth, rides in the fraction of the neighbour count for the renderer.
  float floorNow = floorAt(pos);
  float waterNow = clamp((u_landLevel - floorNow) / u_landLevel, 0.0, 1.0);
  float zNow = swimDepthNear(pos, u_landLevel * (1.0 - swim * waterNow), floorNow, near, nearCount);
  float swimNow = clamp((u_landLevel - zNow) / max(u_landLevel - floorNow, 1e-4), 0.0, 0.999);
  // Tail beat: integrated, so a change of speed changes the rate, never the
  // pose. Faster fish beat faster.
  float phase = texelFetch(u_aux, own, 0).w + u_dt * 6.2832 * u_beat * (1.5 + length(vel) * 0.03);
  o_aux = vec4(acc, float(count) + swimNow, mod(phase, 6.2832));
}
`
