import { LOG_ELEV_PER_PX, MAX_LOG_SEGMENTS } from '../sim/Logs.js'
import { LAND_LEVEL } from '../sim/PondMap.js'

/** Koi colours, indexed by traits.x. Kept in sync with PALETTE in render/shaders.js. */
export const BOID_COLORS = ['gold', 'blue', 'white', 'orange', 'black']
/** Candidates a fish looks at, per neighbour it may count: bounds the cost in crowds. */
const SCAN_PER_NEIGHBOR = 6

/** Vertical swimming: how hard a fish's depth springs to where it wants to be (1/s²), the damping (1/s), its fastest climb or dive as a share of its top speed, and how far its depth wanders (share of the water depth). */
const VERT_SPRING = 6
const VERT_DAMP = 5
const VERT_MAX = 0.6
const DEPTH_WANDER = 0.08

/**
 * Fish as a species of the GPU base boid (gpu/boids/BoidKernel.js): no genome
 * yet (their behaviour is the global params), traits (colour, preferred swim
 * depth as a fraction of the water depth, tail-beat phase offset), aux
 * (steering ax, ay, neighbours, tail phase), vert (z: px below the surface,
 * negative; vz).
 *
 * They see their own kind in a cone (`fov`) within `perception`: alignment,
 * cohesion and separation, each Reynolds steering weighted by its param; then
 * the shore and trunks in their way at their depth, seen with rays fanned
 * across the field of view, steer them to the clearest water. Vertically each
 * swims towards its preferred depth (wandering a little, slowly), or over or
 * under a trunk ahead; its depth follows on a damped spring at a capped rate,
 * so a trunk is solid until it has actually risen or dived past it.
 */
/** What a fish recognises (for the focus legend). */
export const FISH_SENSES = [{ key: 'fish', label: 'Fish', kind: 'flock' }]

export const FISH = {
  name: 'fish',
  genes: [],
  senses: FISH_SENSES,
  /** Forces the debug pass reports (render/focus.js keys and their GLSL). */
  forces: [
    ['alignment', 'fAl'],
    ['cohesion', 'fCo'],
    ['separation', 'fSe'],
    ['wall', 'fWall'],
    ['total', 'acc'],
  ],
  modeChannel: -1, // no modes: every fish is in the grid
  vertical: true,
  /** The largest range it sees within (sets the grid cell). */
  maxRange: (p) => p.perception,
  /** Fastest a fish moves (px/s), with room for the shore pushing it. */
  maxSpeed: (p) => p.maxSpeed * 1.2 + 10,
  textures: ['u_sdf', 'u_elev', 'u_trunkMap'],
  /** Tick rate: steps between looks at the shoal (params.fishLookEvery); in between it recalls these totals. */
  tickParam: 'fishLookEvery',
  remember: { count: 'int', al: 'vec2', co: 'vec2', se: 'vec2' },
  bindTextures: (ctx) => ({ u_sdf: ctx.mapTex.sdf, u_elev: ctx.mapTex.elevation, u_trunkMap: ctx.mapTex.trunkMap }),
  setUniforms(gl, u, { params: p, mapTex }) {
    gl.uniform2fv(u.u_sdfExtent, mapTex.sdfExtent)
    gl.uniform1f(u.u_sdfCell, mapTex.sdfCell)
    gl.uniform1f(u.u_elevCell, mapTex.elevCell)
    gl.uniform2fv(u.u_elevDims, mapTex.elevDims)
    gl.uniform1f(u.u_landLevel, LAND_LEVEL)
    gl.uniform4fv(u['u_logs[0]'], mapTex.logUniforms)
    gl.uniform1i(u.u_logCount, mapTex.logCount)
    gl.uniform1f(u.u_logElevPerPx, LOG_ELEV_PER_PX)
    gl.uniform1f(u.u_perception, p.perception)
    gl.uniform1f(u.u_separation, p.separation)
    gl.uniform1f(u.u_cosHalfFov, Math.cos(((p.fov * Math.PI) / 180) * 0.5))
    gl.uniform1i(u.u_fullFov, p.fov >= 359.9 ? 1 : 0)
    gl.uniform1f(u.u_minSpeed, p.minSpeed)
    gl.uniform1f(u.u_maxSpeed, p.maxSpeed)
    gl.uniform1f(u.u_maxForce, p.maxForce)
    gl.uniform1i(u.u_maxNeighbors, p.maxNeighbors)
    gl.uniform1i(u.u_scanBudget, p.maxNeighbors * SCAN_PER_NEIGHBOR)
    gl.uniform3f(u.u_weights, p.alignWeight, p.cohesionWeight, p.separationWeight)
    gl.uniform1f(u.u_wallWeight, p.wallWeight)
    gl.uniform1f(u.u_beat, p.swimBeat)
    gl.uniform1f(u.u_bodySize, p.boidSize)
  },
  /** The selected fish for the panel, from its state, aux, traits (one texel each). */
  describe: (s, a, tr, genome, time, p, v) => ({ color: BOID_COLORS[tr[0]], speed: Math.hypot(s[2], s[3]), steering: Math.hypot(a[0], a[1]), neighbors: Math.floor(a[2]), position: [s[0], s[1], v?.[0] ?? 0], velocity: [s[2], s[3], v?.[1] ?? 0] }),
  /** A fresh fish at (x, y): state, aux, traits, genome. */
  spawn(x, y, p) {
    const a = Math.random() * Math.PI * 2
    const v = p.minSpeed + Math.random() * (p.maxSpeed - p.minSpeed)
    return {
      state: [x, y, Math.cos(a) * v, Math.sin(a) * v],
      aux: [0, 0, 0, 0],
      traits: [Math.floor(Math.random() * BOID_COLORS.length), Math.random(), Math.random(), 0],
      vert: [-2, 0, 0, 0], // just under the surface: it dives to its depth
    }
  },
  glsl: {
    decl: /* glsl */ `
uniform sampler2D u_sdf; // signed distance to shore in px, + water, - land
uniform vec2 u_sdfExtent;
uniform float u_sdfCell;
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
uniform float u_perception;
uniform float u_separation;
uniform float u_cosHalfFov;
uniform bool u_fullFov;
uniform float u_minSpeed;
uniform float u_maxSpeed;
uniform float u_maxForce;
uniform vec3 u_weights; // alignment, cohesion, separation
uniform float u_wallWeight;
uniform float u_beat;      // tail-beat frequency multiplier
uniform float u_bodySize;  // drawn size: the snout is 1.6x this ahead of the centre, the tail fin's end 1.75x behind
const float VERT_SPRING = ${VERT_SPRING.toFixed(2)};
const float VERT_DAMP = ${VERT_DAMP.toFixed(2)};
const float VERT_MAX = ${VERT_MAX.toFixed(2)};
const float DEPTH_WANDER = ${DEPTH_WANDER.toFixed(3)};
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

#define FLOCK_ON true
#define FLOCK_N count
#define DEBUG_POS pos
#define DEBUG_VEL vel
`,
    pre: /* glsl */ `
  float sp = length(vel);
  vec2 h = sp > 0.0 ? vel / sp : vec2(1.0, 0.0);
  float RANGE = u_perception;
  float sep2 = u_separation * u_separation;
  int count = 0;
  vec2 al = vec2(0.0);
  vec2 co = vec2(0.0);
  vec2 se = vec2(0.0);`,
    visit: /* glsl */ `
        if (!u_fullFov && dot(d, h) < u_cosHalfFov * sqrt(d2)) continue;
        count++;
        al += nb.zw;
        co += d;
        if (d2 < sep2) se -= d / d2; // closer neighbours push harder`,
    act: /* glsl */ `
  // Each force on its own (the debug variant reports them), then summed.
  vec2 fAl = vec2(0.0);
  vec2 fCo = vec2(0.0);
  vec2 fSe = vec2(0.0);
  if (count > 0) {
    fAl = u_weights.x * steer(al, vel);
    fCo = u_weights.y * steer(co, vel);
    fSe = u_weights.z * steer(se, vel);
  }
  vec2 acc = fAl + fCo + fSe;

  float am = length(acc);
  float aLimit = u_maxForce * 2.0;
  if (am > aLimit) acc *= aLimit / am;

  // The fish's elevation now, from its height (px below the surface).
  vec4 traits = texelFetch(u_traits, own, 0);
  float swim = traits.y;
  float z = vert.x;
  float vz = vert.y;
  float zf = u_landLevel + z * u_logElevPerPx;
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
  vec2 fWall = vec2(0.0);
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
    fWall = u_wallWeight * urgency * steer(open + away * urgency, vel);
    acc += fWall;
  }

  vel += acc * u_dt;
  float v = length(vel);
  float lo = u_minSpeed;
  float hi = u_maxSpeed;
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
  // Where it wants to swim: its own depth (wandering slowly about it) as a
  // share of the water below, or over or under a trunk in the way.
  float floorNow = floorAt(pos);
  float waterNow = clamp((u_landLevel - floorNow) / u_landLevel, 0.0, 1.0);
  float wander = DEPTH_WANDER * sin(u_time * (0.08 + 0.06 * traits.z) + traits.z * 40.0);
  float zOwn = u_landLevel * (1.0 - clamp(swim + wander, 0.02, 0.98) * waterNow);
  float zNow = swimDepthNear(pos, zOwn, floorNow, near, nearCount);
  if (nearCount > 0) {
    // The whole body passes the trunk at one depth: also ask at the snout and
    // the tail's end, and keep whichever moves furthest from its own depth, so
    // the fish rises or dives before its snout reaches a trunk and stays there
    // until its tail has cleared it (the renderer hides it under trunks per
    // pixel, at this one depth). Only near trunks: two more short loops.
    float sp = length(vel);
    vec2 head = sp > 1e-3 ? vel / sp : vec2(1.0, 0.0);
    float zHead = swimDepthNear(pos + head * (1.6 * u_bodySize), zOwn, floorNow, near, nearCount);
    float zTail = swimDepthNear(pos - head * (1.75 * u_bodySize), zOwn, floorNow, near, nearCount);
    if (abs(zHead - zOwn) > abs(zNow - zOwn)) zNow = zHead;
    if (abs(zTail - zOwn) > abs(zNow - zOwn)) zNow = zTail;
  }
  // Its depth follows on a damped spring, no faster than VERT_MAX of its top
  // speed, between the floor and the surface.
  float zWant = (zNow - u_landLevel) / u_logElevPerPx;
  vz += ((zWant - z) * VERT_SPRING - vz * VERT_DAMP) * u_dt;
  vz = clamp(vz, -u_maxSpeed * VERT_MAX, u_maxSpeed * VERT_MAX);
  z += vz * u_dt;
  float bottom = -0.999 * max(u_landLevel - floorNow, 0.0) / u_logElevPerPx;
  if (z < bottom || z > -0.5) {
    z = clamp(z, bottom, -0.5);
    vz = 0.0;
  }
  o_vert = vec4(z, vz, 0.0, 0.0);
  // Tail beat: integrated, so a change of speed changes the rate, never the
  // pose. Faster fish beat faster.
  float phase = texelFetch(u_aux, own, 0).w + u_dt * 6.2832 * u_beat * (1.5 + length(vel) * 0.03);
  o_aux = vec4(acc, float(count), mod(phase, 6.2832));
`,
  },
}
