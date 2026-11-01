import { LOG_ELEV_PER_PX } from '../sim/Logs.js'
import { LAND_LEVEL } from '../sim/PondMap.js'
import { RIPPLE_LIFE } from '../sim/Insects.js'
import { LAND_FLAG } from '../sim/Vegetation.js'

// Boid data is read straight from the simulation textures with texelFetch,
// indexed by gl_InstanceID; geometry comes from gl_VertexID. No vertex buffers.
const COMMON_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 u_resolution;
uniform vec2 u_viewOffset; // world position of the screen's top-left corner
uniform int u_texW;
uniform int u_texShift;
uniform int u_instanceOffset;
uniform sampler2D u_state; // (x, y, vx, vy)
uniform sampler2D u_aux;   // (ax, ay, neighbours, tail phase)
uniform sampler2D u_traits; // (colour index, -, -, -)

ivec2 coordOf(int i) { return ivec2(i & (u_texW - 1), i >> u_texShift); }
int boidId() { return gl_InstanceID + u_instanceOffset; }
vec4 boidState() { return texelFetch(u_state, coordOf(boidId()), 0); }
vec4 boidAux() { return texelFetch(u_aux, coordOf(boidId()), 0); }
vec4 boidTraits() { return texelFetch(u_traits, coordOf(boidId()), 0); }

// All positions are in world px; the view shows u_resolution px from u_viewOffset.
vec4 toClip(vec2 p) {
  vec2 c = (p - u_viewOffset) / u_resolution * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}

// Forward/right basis from a vector.
void basisFrom(vec2 v, out vec2 f, out vec2 r, out float m) {
  m = length(v);
  f = m > 1e-5 ? v / m : vec2(1.0, 0.0);
  r = vec2(-f.y, f.x);
}
`

// Live-tunable look parameters (the control panel), shared by all render
// programs through one uniform block that the renderer updates once per frame
// (see TUNABLES in BoidRenderer.js for the slots and their units). The names
// read like the constants they replaced. Include guard: several snippets
// pull it in.
const TUNE = /* glsl */ `
#ifndef TUNE_BLOCK
#define TUNE_BLOCK
layout(std140) uniform Tunables { highp vec4 u_tune[7]; };
#define SHADOW u_tune[0].x            // light let through a shadow
#define PLANT_SELF_SHADE u_tune[0].y  // light reaching shaded plant bases
#define MURK_SURFACE u_tune[0].z      // fish fade right below the surface
#define MURK_DEEP u_tune[0].w         // fish fade on the deepest bottom
#define CLOUD_SCALE u_tune[1].x       // noise tiles per world px
#define CLOUD_COVER u_tune[1].y       // density where cloud starts
#define CLOUD_EDGE u_tune[1].z        // density range from wisp to core
#define CLOUD_SHADE u_tune[1].w       // light let through under a core
#define SWIRL_STRENGTH u_tune[2].x    // brightness change of the silt swirl
#define SWIRL_SCALE u_tune[2].y       // world px per swirl noise tile
#define SWIRL_SPEED u_tune[2].z       // tiles per second the eddies turn over
#define CAUSTIC_STEP u_tune[2].w      // brightness of a caustic line
#define CAUSTIC_DEPTH u_tune[3].x     // depth beyond which no caustics reach the floor
#define CAUSTIC_SCALE u_tune[3].y     // world px per caustic noise tile
#define CAUSTIC_SPEED u_tune[3].z     // how fast the caustic web shifts
#define RIPPLE_ALPHA u_tune[3].w      // glint opacity
#define RIPPLE_WAVELENGTH u_tune[4].x // world px between crests
#define RIPPLE_SPEED u_tune[4].y      // crest phase speed, rad/s
#define REFRACTION u_tune[4].z        // floor wobble through ripples, px
#define VIGNETTE u_tune[4].w
#define BREEZE u_tune[5].x            // how far plants lean in the wind
#define PLANT_BEND u_tune[5].y        // how far fish push plants
#define DITHER u_tune[5].z            // 0 = plain rounding .. 1 = ordered dither
#define SWIM_WIGGLE u_tune[5].w       // tail swing (body undulation amplitude)
#define LOG_MURK u_tune[6].x          // how fast submerged trunks fade into the murk
#define DEEP_FADE u_tune[6].y         // how much deep fish lose colour and sharpness
#define SILT_OPACITY u_tune[6].z      // opacity of the densest silt cloud
#define SLUDGE u_tune[6].w            // how much of the shallow-mid floor the sludge covers
// How far something at this depth (0 = surface .. 1 = deepest floor) has
// faded into the water: fish, the floor, and the shadows on it alike.
float murkAt(float depth) { return mix(MURK_SURFACE, MURK_DEEP, depth); }
#endif
`

/** Scene pixels per texel of the coarse light map (shadeFS). */
export const SHADE_CELL = 8

// Hard shadows: a scene-resolution mask of projected silhouettes, sampled at
// the fragment's own pixel; one flat darkness, no gradients.
//   r = plant shadow (falls on everything below the plant tops)
//   g = floating scum / pad shadow (falls only below the surface: water, fish)
//   b = trunk shadow (everything but the trunks themselves, which are round
//       and would otherwise shadow their own top)
const MASK = /* glsl */ `${TUNE}
uniform sampler2D u_shadowMask;
vec3 maskAt() { return texelFetch(u_shadowMask, ivec2(gl_FragCoord.xy), 0).rgb; }
float shade() { vec3 m = maskAt(); return max(m.r, m.b) > 0.5 ? SHADOW : 1.0; }
float shadeAll() { vec3 m = maskAt(); return max(max(m.r, m.g), m.b) > 0.5 ? SHADOW : 1.0; }
// Trunks: shaded by plants (and, under water, floating mats), never by trunks.
float shadeTrunk(bool underwater) { vec3 m = maskAt(); return max(m.r, underwater ? m.g : 0.0) > 0.5 ? SHADOW : 1.0; }
// The pond floor at water depth 0..1: plant, trunk, scum and pad shadows
// reach it through the water, softer and fainter the deeper it is (like the
// fish shadows): the mask is averaged over a disc that widens with depth.
const vec2 SHADOW_DISC[8] = vec2[8](
  vec2(1.0, 0.0), vec2(0.71, 0.71), vec2(0.0, 1.0), vec2(-0.71, 0.71),
  vec2(-1.0, 0.0), vec2(-0.71, -0.71), vec2(0.0, -1.0), vec2(0.71, -0.71));
// How much of a point at this depth is in shadow (0..1), counting the mask
// channels picked by \`use\`.
float shadowCover(float depth, vec3 use) {
  vec3 m = maskAt() * use;
  float shadow = max(max(m.r, m.g), m.b);
  float radius = depth * 7.0; // scene px
  if (radius > 0.75) {
    ivec2 hi = textureSize(u_shadowMask, 0) - 1;
    for (int i = 0; i < 8; i++) {
      // Two rings: half and full radius.
      vec2 o = SHADOW_DISC[i] * radius * (i % 2 == 0 ? 1.0 : 0.5);
      vec3 n = texelFetch(u_shadowMask, clamp(ivec2(gl_FragCoord.xy + o), ivec2(0), hi), 0).rgb * use;
      shadow += max(max(n.r, n.g), n.b);
    }
    shadow /= 9.0;
  }
  return shadow;
}
float shadeFloor(float depth) {
  return mix(1.0, SHADOW, shadowCover(depth, vec3(1.0)) * (1.0 - murkAt(depth))); // seen through the murk
}
// Something under water at \`depth\` (0..1) seen through the murk \`murk\`
// against the water there (unshaded colour, water depth \`waterDepth\`): its
// shadows soften with depth like the floor's, and it fades into the water as
// shaded as the floor around it, so a deep shape never shows as a dark patch.
vec3 underWater(vec3 c, float depth, vec3 use, float murk, vec3 water, float waterDepth) {
  return mix(c * mix(1.0, SHADOW, shadowCover(depth, use)), water * shadeFloor(waterDepth), murk);
}
`

// Fallen trunks (Logs.js), read from a small texture: row i = segment i,
// texels (ax, ay, bx, by), (ra, rb, za, zb), (seed, length, ends, offset),
// with r the radius in px, z the axis elevation at each end, ends = start +
// 3 * end (0 hidden, 1 broken, 2 rounded joint) and offset the distance along
// the whole trunk where the segment starts.
export const LOGS = /* glsl */ `
uniform highp sampler2D u_logs;
uniform highp int u_logCount;
const float LOG_LAND = ${LAND_LEVEL.toFixed(4)};          // elevation of the water surface
const float LOG_ELEV_PER_PX = ${LOG_ELEV_PER_PX.toFixed(6)}; // elevation units per world px
vec4 logEnds(int i) { return texelFetch(u_logs, ivec2(0, i), 0); }
vec4 logSize(int i) { return texelFetch(u_logs, ivec2(1, i), 0); }
vec4 logLook(int i) { return texelFetch(u_logs, ivec2(2, i), 0); }
// Cross-section of segment i at p: (t along the axis, unclamped; signed
// distance from the axis / radius, round past the ends; axis elevation;
// radius as elevation).
vec4 logSection(int i, vec2 p) {
  vec4 e = logEnds(i);
  vec4 sz = logSize(i);
  vec2 ab = e.zw - e.xy;
  float t = dot(p - e.xy, ab) / dot(ab, ab);
  float tc = clamp(t, 0.0, 1.0);
  float r = mix(sz.x, sz.y, tc);
  vec2 d = p - (e.xy + ab * tc);
  float side = dot(d, vec2(-ab.y, ab.x)) < 0.0 ? -1.0 : 1.0;
  return vec4(t, side * length(d) / r, mix(sz.z, sz.w, tc), r * LOG_ELEV_PER_PX);
}
// Whether a section lies on the segment: within its length, or within the
// round cap of an end that joins the next segment.
bool logCovers(int i, vec4 sec) {
  if (abs(sec.y) > 1.0) return false;
  if (sec.x >= 0.0 && sec.x <= 1.0) return true;
  int ends = int(logLook(i).z + 0.5);
  return sec.x < 0.0 ? ends - (ends / 3) * 3 == 2 : ends / 3 == 2;
}
// Elevation of the round top of the trunk at a cross-section.
float logTop(vec4 sec) { return sec.z + sec.w * sqrt(max(0.0, 1.0 - sec.y * sec.y)); }
// Highest trunk surface over p, or -1 where there is none.
float logTopAt(vec2 p) {
  float top = -1.0;
  for (int i = 0; i < u_logCount; i++) {
    vec4 e = logEnds(i);
    vec4 sz = logSize(i);
    float r = max(sz.x, sz.y);
    if (p.x < min(e.x, e.z) - r || p.x > max(e.x, e.z) + r || p.y < min(e.y, e.w) - r || p.y > max(e.y, e.w) + r) continue;
    vec4 sec = logSection(i, p);
    if (logCovers(i, sec)) top = max(top, logTop(sec));
  }
  return top;
}
// Distance (px) from p to the nearest trunk side, whatever its depth; far
// where none is closer than that.
float logDistance(vec2 p, float far) {
  float best = far;
  for (int i = 0; i < u_logCount; i++) {
    vec4 e = logEnds(i);
    vec4 sz = logSize(i);
    float m = max(sz.x, sz.y) + far;
    if (p.x < min(e.x, e.z) - m || p.x > max(e.x, e.z) + m || p.y < min(e.y, e.w) - m || p.y > max(e.y, e.w) + m) continue;
    vec4 sec = logSection(i, p);
    float r = sec.w / LOG_ELEV_PER_PX;
    best = min(best, (abs(sec.y) - 1.0) * r);
  }
  return best;
}
`

// Drifting clouds, shared by the post pass (cloud shadows) and the water
// (no caustics or glints without sun). Density is four octaves of the tiling
// noise texture, each drifting with the wind at its own speed (so clouds
// change shape as they go), domain-warped so the outlines curl. Cores are the
// densest; towards the edges density falls off and breaks into streaks
// stretched along the wind, so the edges are wispy and lighter.
const CLOUDS = /* glsl */ `${TUNE}
uniform sampler2D u_clouds;  // tiling noise (clouds.js)
uniform vec2 u_cloudShift;   // how far the wind has carried the clouds (world px)
uniform vec2 u_wind;         // unit vector the wind blows towards

float cloud(vec2 p) { return texture(u_clouds, p).r; }

// 0 = clear sky .. 1 = cloud core.
float cloudCover(vec2 world) {
  vec2 p = world * CLOUD_SCALE;
  vec2 s = u_cloudShift * CLOUD_SCALE;
  // Slow, large warp: curls the outlines.
  vec2 warp = vec2(cloud(p * 0.6 - s * 0.7 + 0.13), cloud(p * 0.6 - s * 0.7 + 0.71)) - 0.5;
  vec2 q = p + warp * 0.18;
  // Octaves: finer ones move faster, as smaller wisps blow ahead.
  float n = cloud(q - s) * 0.42
    + cloud(q * 1.9 - s * 1.3 + 0.37) * 0.26
    + cloud(q * 3.7 - s * 1.7 + 0.61) * 0.18
    + cloud(q * 7.3 - s * 2.3 + 0.19) * 0.14;
  float d = smoothstep(CLOUD_COVER, CLOUD_COVER + CLOUD_EDGE, n);
  // Wisps: fine noise stretched 5x along the wind tears the thin edges into
  // streaks; the cores (d -> 1) stay whole.
  vec2 along = vec2(dot(p, u_wind), dot(p, vec2(-u_wind.y, u_wind.x)));
  vec2 sAlong = vec2(dot(s, u_wind), 0.0);
  float streak = cloud(vec2(along.x * 3.0, along.y * 15.0) - sAlong * 3.6 + 0.5);
  return d * mix(smoothstep(0.3, 0.7, streak), 1.0, d * d);
}
`

// Koi palette: gold, blue, white, orange, black (order = BOID_COLORS in GpuBoidSim).
// The fish is a little spine mesh built from gl_VertexID: 4 body segments
// from the nose (x = 1.6) to the tail root (x = -1.0), then the caudal fin.
// Seen from above a fish's tail fin is vertical, so it is just a thin slit. The body undulates with a travelling wave whose amplitude grows
// towards the tail (tail phase integrated by the simulation, aux.w), and
// curves into turns (steering acceleration, aux.xy).
export const FISH_VERTS = 30
export const boidVS = /* glsl */ `${COMMON_VS}
${TUNE}
const float SPINE[5] = float[5](1.6, 0.9, 0.2, -0.5, -1.0);
const float WIDTH[5] = float[5](0.0, 0.42, 0.45, 0.3, 0.12);
const vec2 Q[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(1, 1), vec2(0, -1), vec2(1, 1), vec2(0, 1));
const vec2 FIN[6] = vec2[6](
  vec2(-0.95, -0.07), vec2(-1.75, -0.04), vec2(-1.75, 0.04),
  vec2(-0.95, -0.07), vec2(-1.75, 0.04), vec2(-0.95, 0.07)
);
const vec3 PALETTE[5] = vec3[5](
  vec3(0.88, 0.68, 0.26),
  vec3(0.36, 0.52, 0.82),
  vec3(0.88, 0.87, 0.82),
  vec3(0.90, 0.44, 0.18),
  vec3(0.09, 0.09, 0.11)
);
uniform float u_size;
uniform vec2 u_shift;
uniform int u_mode;  // 0 = palette colour, 1 = drop shadow, 2 = flat u_tint
uniform vec3 u_tint;
uniform float u_maxForce;
uniform float u_pixel; // world px per scene pixel
uniform vec2 u_light;  // shadow offset per px of height, away from the sun
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
out vec4 v_color;
out float v_swimDepth; // 0 = at the surface .. 1 = on the bottom; < 0 = not murked
out vec2 v_world;
out float v_edge; // -1 .. 1 across the body
out float v_blur; // 0 = crisp .. 1 = deep fish, edges faded out
out vec2 v_soft;  // shadow: position in its soft blob (0 = centre, 1 = faded out)
const float LAND = ${LAND_LEVEL.toFixed(4)};
const float ELEV_PER_PX = ${LOG_ELEV_PER_PX.toFixed(6)};
void main() {
  vec4 s = boidState();
  vec4 aux = boidAux();
  vec4 traits = boidTraits();
  v_swimDepth = -1.0;
  v_soft = vec2(0.0);
  v_blur = 0.0;
  vec2 f, r; float m;
  basisFrom(s.zw, f, r, m);
  vec2 local;
  if (gl_VertexID < 24) {
    int seg = gl_VertexID / 6;
    vec2 q = Q[gl_VertexID - seg * 6];
    int node = seg + int(q.x);
    local = vec2(SPINE[node], WIDTH[node] * q.y);
    v_edge = q.y;
  } else {
    v_edge = 0.0;
    local = FIN[gl_VertexID - 24];
    // At least a pixel wide, so the slit never breaks up into dots.
    local.y = sign(local.y) * max(abs(local.y), 0.5 * u_pixel / max(u_size, 1e-3));
  }
  // Travelling wave from head to tail; amplitude ~ (distance from nose)^2.
  float back = (1.6 - local.x) / 3.35;
  float phase = aux.w + traits.z * 6.2832;
  local.y += SWIM_WIGGLE * 1.6 * back * back * sin(phase - back * 4.0);
  // Turning: the body bends into an arc around the turn centre.
  float turn = clamp(dot(aux.xy, r) / max(u_maxForce, 1.0), -1.0, 1.0);
  local.y += turn * 0.07 * (local.x - 0.3) * (local.x - 0.3);
  float floorE = texture(u_elev, (s.xy / u_elevCell + 0.5) / u_elevDims).r;
  float depth = clamp((LAND - floorE) / LAND, 0.0, 1.0); // water depth here, 0..1
  // Where it swims now, rising over or diving under trunks (the sim's aux.z fraction).
  float swim = fract(aux.z);
  if (u_mode == 0) {
    // Deep fish blur: the body widens a little and its rim fades (see boidFS).
    v_blur = DEEP_FADE * smoothstep(0.1, 0.7, swim * depth);
    local.y *= 1.0 + 0.7 * v_blur;
  }
  vec2 p = s.xy + (f * local.x + r * local.y) * u_size + u_shift;
  if (u_mode == 0) {
    vec3 c = PALETTE[clamp(int(traits.x), 0, 4)];
    // Slightly lighter nose so dark koi still read on deep water.
    v_color = vec4(mix(c, vec3(0.9), 0.15 * step(1.0, local.x)), 1.0);
    v_swimDepth = swim;
  } else if (u_mode == 1) {
    // Shadow on the floor, cast from the fish's height above it. Only fish
    // near the surface (over not too deep a floor) leave a visible one.
    float above = min((1.0 - swim) * depth * LAND / ELEV_PER_PX, 60.0); // px
    // A soft blob rather than a crisp silhouette: the body, widened and faded
    // out towards its rim, spreading the higher the fish swims. No fin.
    if (gl_VertexID >= 24) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float spread = 1.0 + 0.6 * above / 60.0;
    vec2 blob = vec2((local.x - 0.3) * 1.2 * spread + 0.3, local.y * 2.2 * spread);
    v_soft = vec2((local.x - 0.3) * 1.2 / 1.55, local.y * 2.2);
    p = s.xy + (f * blob.x + r * blob.y) * u_size + u_light * above;
    float near = 1.0 - smoothstep(0.0, 0.35, swim * depth);
    // As dark as the plants' shadows at its core (Sky > shadow darkness).
    v_color = vec4(0.0, 0.02, 0.05, (1.0 - SHADOW) * near * (1.0 - murkAt(depth)) / spread);
  } else {
    v_color = vec4(u_tint, 1.0);
  }
  v_world = p;
  gl_Position = toClip(p);
}
`

// Murky water: a fish fades into the water around it the deeper it swims.
// The cached background holds the unshaded water colour (rgb) and the water
// depth there (a); each fish has its own preferred depth (traits.y) as a
// fraction of the water depth, so some cruise near the surface and stay
// clear while others are only dim shapes over deep water.
export const boidFS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in float v_swimDepth;
in highp vec2 v_world;
in float v_edge;
in float v_blur;
in vec2 v_soft;
uniform sampler2D u_background;
uniform highp sampler2D u_trunks; // baked trunk map (MapTextures): r = trunk top elevation, -1 = none
out vec4 o;
${MASK}
void main() {
  vec3 c = v_color.rgb;
  bool submerged = v_swimDepth >= 0.0;
  if (submerged) {
    vec4 water = texelFetch(u_background, ivec2(gl_FragCoord.xy), 0);
    // Hidden under a trunk lying above it (the trunk is drawn before the fish).
    float zf = ${LAND_LEVEL.toFixed(4)} * (1.0 - v_swimDepth * water.a);
    ivec2 t = clamp(ivec2(v_world), ivec2(0), textureSize(u_trunks, 0) - 1);
    if (texelFetch(u_trunks, t, 0).r > zf) discard;
    float below = v_swimDepth * water.a; // depth below the surface, 0..1
    // Deeper down the colour drains away (before the murk takes over).
    c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), DEEP_FADE * smoothstep(0.1, 0.7, below));
    c = underWater(c, below, vec3(1.0), murkAt(below), water.rgb, water.a);
  } else c *= shadeAll();
  // Shadows fade out at their rim; deep fish fade out across their widened sides.
  float alpha = v_color.a * (1.0 - smoothstep(0.1, 1.0, length(v_soft))) * (1.0 - v_blur * smoothstep(0.2, 1.0, abs(v_edge)));
  o = vec4(c * alpha, alpha);
}
`

// Arrow = shaft quad + head triangle.
// shape: (fraction of length, side unit, head extension unit, isHead)
export const vectorVS = /* glsl */ `${COMMON_VS}
const vec4 A[9] = vec4[9](
  vec4(0, -1, 0, 0), vec4(1, -1, 0, 0), vec4(1, 1, 0, 0),
  vec4(0, -1, 0, 0), vec4(1, 1, 0, 0), vec4(0, 1, 0, 0),
  vec4(1, -1, 0, 1), vec4(1, 1, 0, 1), vec4(1, 0, 1, 1)
);
uniform int u_source;     // 0 = velocity, 1 = steering
uniform float u_scale;    // px per vector unit
uniform float u_ref;      // magnitude considered "full intensity"
uniform float u_width;
uniform float u_offset;   // start distance from boid centre
uniform vec3 u_low;
uniform vec3 u_high;
out vec4 v_color;
void main() {
  vec4 s = boidState();
  vec2 vec = u_source == 0 ? s.zw : boidAux().xy;
  vec2 f, r; float m;
  basisFrom(vec, f, r, m);
  vec4 a = A[gl_VertexID];
  float t = clamp(m / u_ref, 0.0, 1.0);
  float len = m * u_scale;
  float vis = step(0.5, len); // collapse negligible arrows
  float along = u_offset + a.x * len + a.z * u_width * 3.0;
  float side = a.y * mix(u_width * 0.5, u_width * 1.9, a.w);
  vec2 p = s.xy + (f * along + r * side) * vis;
  v_color = vec4(mix(u_low, u_high, t), mix(0.35, 1.0, t));
  gl_Position = toClip(p);
}
`

export const vectorFS = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() {
  o = vec4(v_color.rgb * v_color.a, v_color.a);
}
`

// Vision: disc of radius = perception, clipped to the field-of-view sector,
// with an outer rim and an inner ring at the separation radius.
// u_rings = 0: one quad over the whole disc (with fill).
// u_rings = 1: only thin bands along the two rings, over the FOV arc
//   (RING_SEGMENTS quads each), so thousands of discs rasterize ~4x fewer pixels.
export const RING_SEGMENTS = 12
export const visionVS = /* glsl */ `${COMMON_VS}
const vec2 Q[6] = vec2[6](
  vec2(-1, -1), vec2(1, -1), vec2(1, 1),
  vec2(-1, -1), vec2(1, 1), vec2(-1, 1)
);
const int SEG = ${RING_SEGMENTS};
uniform float u_radius;
uniform int u_rings;
uniform float u_band;      // ring band half-width, world px
uniform float u_halfSpan;  // half the FOV arc, radians (slightly padded)
uniform float u_sepRatio;
out vec2 v_local; // boid frame: x = forward, y = right, unit = radius
void main() {
  vec4 s = boidState();
  vec2 f, r; float m;
  basisFrom(s.zw, f, r, m);
  vec2 corner; // world-aligned offset, unit = radius
  if (u_rings == 0) {
    corner = Q[gl_VertexID];
    v_local = vec2(dot(corner, f), dot(corner, r));
  } else {
    int ring = gl_VertexID / (SEG * 6);
    int v = gl_VertexID - ring * SEG * 6;
    int seg = v / 6;
    vec2 q = Q[v - seg * 6]; // x: along the segment, y: across the band
    float segAngle = 2.0 * u_halfSpan / float(SEG);
    float a = -u_halfSpan + (float(seg) + q.x * 0.5 + 0.5) * segAngle;
    float R = (ring == 0 ? 1.0 : u_sepRatio) * u_radius;
    // The outer edge is pushed out so the straight chord still covers the arc.
    float rad = q.y < 0.0 ? max(R - 2.0 * u_band, 0.0) : (R + u_band) / cos(segAngle * 0.5);
    v_local = vec2(cos(a), sin(a)) * rad / u_radius;
    corner = f * v_local.x + r * v_local.y;
  }
  gl_Position = toClip(s.xy + corner * u_radius);
}
`

export const visionFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
uniform float u_cosHalfFov;
uniform float u_sepRatio;
uniform vec3 u_color;
uniform float u_fill;
uniform float u_rim;
out vec4 o;
void main() {
  float d = length(v_local);
  float aa = fwidth(d) * 1.2;
  if (d > 1.0 + aa) discard;

  float c = v_local.x / max(d, 1e-5);
  float fovAa = fwidth(c) * 1.5 + 1e-3;
  float inFov = u_cosHalfFov <= -0.999 ? 1.0 : smoothstep(u_cosHalfFov - fovAa, u_cosHalfFov + fovAa, c);
  if (inFov <= 0.0) discard;

  float outer = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float rim = smoothstep(1.0 - aa * 2.5, 1.0 - aa * 0.5, d) * outer;
  float sepRing = 1.0 - smoothstep(0.0, aa, abs(d - u_sepRatio));

  float a = inFov * (u_fill * outer + u_rim * rim + u_rim * 0.5 * sepRing);
  if (a < 0.002) discard; // spare the blender the (mostly empty) interior
  o = vec4(u_color * a, a);
}
`

// Fullscreen background layer for painted regions (influence field).
export const fieldVS = /* glsl */ `#version 300 es
uniform vec2 u_uvScale; // world size / (field cells * cell size)
uniform vec2 u_uvOffset;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  v_uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5) * u_uvScale + u_uvOffset;
  gl_Position = vec4(p, 0.0, 1.0);
}
`

export const fieldFS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_field;
out vec4 o;
void main() {
  vec4 c = texture(u_field, v_uv);
  o = vec4(c.rgb * c.a, c.a);
}
`

// Shared noise helpers for the background.
const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
`

// Water and land: water colour is a smooth gradient by floor depth, with
// patches of sludge on the floor; land is dark earth and moss with a wet mud
// band along the shore.
export const waterFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_elev;
uniform sampler2D u_sdf;
uniform float u_elevCell;
uniform vec2 u_elevDims;
uniform vec2 u_sdfExtent;
uniform vec2 u_view;     // world extent covered by the framebuffer
uniform vec2 u_viewOffset;
uniform float u_landLevel;
uniform vec2 u_seedOffset; // per-map noise offset
uniform float u_litter;    // floor details, 0 = none: leaf litter,
uniform float u_stones;    // pebbles,
uniform float u_twigs;     // sunken twigs
out vec4 o;
${NOISE}
${TUNE}

// Integer hash: exact at any coordinate (the fract-based hash above turns
// blocky at the thousands of px the sludge grid reaches).
float ihash(vec2 cell) {
  uvec2 q = uvec2(ivec2(cell) + 65536);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= h >> 13;
  return float(h) / 4294967296.0;
}

// Sludge on the floor: mats of decaying weed and algae in patches across
// the shallow-to-middle depths, built like the scum mats: overlapping rounded
// clumps on a jittered grid, lighter in the middle, dense inside a patch and
// thinning raggedly towards its edge. Olive, dark green and rotting brown.
const float SLUDGE_CELL = 4.0; // px between clumps
vec4 sludge(vec2 world, float depth) {
  float zone = smoothstep(0.06, 0.18, depth) * (1.0 - smoothstep(0.45, 0.75, depth));
  if (zone <= 0.0 || SLUDGE <= 0.0) return vec4(0.0);
  vec2 seed = u_seedOffset;
  ivec2 base = ivec2(floor(world / SLUDGE_CELL));
  vec4 col = vec4(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      vec2 h = vec2(ihash(c + seed), ihash(c + seed + 71.0));
      vec2 centre = (c + 0.1 + 0.8 * h) * SLUDGE_CELL;
      vec2 p = centre + seed;
      // Patches: broad warped noise cut at a level set by the amount; a clump
      // grows here with the patch's density, so edges thin out clump by clump.
      float patches = fbm(p * 0.0045 + vec2(fbm(p * 0.011 + 3.1), fbm(p * 0.011 + 8.7)) * 0.9);
      float level = mix(0.78, 0.38, SLUDGE) + (1.0 - zone) * 0.25;
      float density = smoothstep(level - 0.01, level + 0.03, patches);
      if (ihash(c + seed + 13.0) >= density) continue;
      float r = (2.2 + 1.4 * ihash(c + seed + 29.0)) * (0.6 + 0.4 * density);
      float dist = length(world - centre);
      if (dist >= r) continue;
      // Regional mix of olive and dark green, with rotting brown here and there.
      float v = ihash(c + seed + 47.0);
      vec3 clump = mix(vec3(0.17, 0.19, 0.08), vec3(0.27, 0.29, 0.11), smoothstep(0.3, 0.7, fbm(p * 0.008 + 20.0)));
      clump = mix(clump, vec3(0.26, 0.19, 0.09), smoothstep(0.55, 0.75, fbm(p * 0.015 + 70.0)) * 0.85);
      clump *= 0.85 + 0.3 * v;                                        // per-clump shade
      clump = mix(clump, vec3(0.35, 0.37, 0.15), step(0.92, v) * 0.6); // a few fresh tufts
      col = vec4(clump * (1.08 - 0.25 * dist / r), 1.0);               // lighter middle
    }
  }
  return col;
}

// Floor details. Like the sludge they live in the cached background, so they
// cost nothing per frame: each is a jittered grid of shapes, one per cell at
// most, found by checking the 3x3 cells around the pixel; whether a cell has
// one is decided per cell (by value noise at the cell), so shapes are whole.

// Leaf litter: fallen leaves, thickest near the banks the trees and shrubs
// drop them from and in drifts, thinning into the deep water. Brown, ochre,
// rust and the grey-brown of old leaves, each with a darker midrib.
const float LEAF_CELL = 5.0;
vec4 litter(vec2 world, float depth, float shore) {
  float zone = (1.0 - smoothstep(0.3, 0.8, depth)) * mix(0.35, 1.0, shore);
  if (u_litter <= 0.0 || zone <= 0.0) return vec4(0.0);
  vec2 seed = u_seedOffset + 311.0;
  ivec2 base = ivec2(floor(world / LEAF_CELL));
  vec4 col = vec4(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      vec2 centre = (c + 0.1 + 0.8 * vec2(ihash(c + seed), ihash(c + seed + 71.0))) * LEAF_CELL;
      float drift = smoothstep(0.3, 0.7, vnoise((centre + seed) * 0.012));
      if (ihash(c + seed + 5.0) >= u_litter * zone * (0.25 + 0.75 * drift)) continue;
      float a = ihash(c + seed + 11.0) * 6.2832;
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (world - centre);
      float len = 1.8 + 1.8 * ihash(c + seed + 17.0);
      float wid = len * (0.4 + 0.25 * ihash(c + seed + 23.0));
      if ((q.x * q.x) / (len * len) + (q.y * q.y) / (wid * wid) >= 1.0) continue;
      float v = ihash(c + seed + 29.0);
      vec3 leaf = v < 0.35 ? vec3(0.36, 0.24, 0.12) : v < 0.6 ? vec3(0.45, 0.34, 0.15) : v < 0.8 ? vec3(0.42, 0.2, 0.1) : vec3(0.3, 0.27, 0.21);
      leaf *= 0.85 + 0.3 * ihash(c + seed + 37.0);
      if (abs(q.y) < 0.35) leaf *= 0.75; // midrib
      col = vec4(leaf, 1.0);
    }
  }
  return col;
}

// Pebbles: beds of small pebbles in the shallows, lit from one side,
// greening with algae the deeper they lie.
const float PEBBLE_CELL = 4.0;
vec3 stoneColour(float v, float depth) {
  vec3 c = mix(vec3(0.36, 0.34, 0.3), vec3(0.3, 0.26, 0.2), v);
  return mix(c, vec3(0.22, 0.27, 0.15), smoothstep(0.15, 0.6, depth) * 0.7);
}
vec4 stones(vec2 world, float depth) {
  if (u_stones <= 0.0) return vec4(0.0);
  vec2 seed = u_seedOffset + 523.0;
  vec4 col = vec4(0.0);
  float zone = 1.0 - smoothstep(0.15, 0.45, depth);
  if (zone <= 0.0) return col;
  ivec2 base = ivec2(floor(world / PEBBLE_CELL));
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      vec2 centre = (c + 0.15 + 0.7 * vec2(ihash(c + seed + 41.0), ihash(c + seed + 43.0))) * PEBBLE_CELL;
      float bed = smoothstep(0.45, 0.65, vnoise((centre + seed) * 0.02));
      if (ihash(c + seed + 47.0) >= u_stones * zone * bed) continue;
      float r = 0.8 + 1.1 * ihash(c + seed + 53.0);
      vec2 p = world - centre;
      if (dot(p, p) >= r * r) continue;
      float lit = 0.85 + 0.3 * dot(p / r, vec2(-0.6, -0.6));
      col = vec4(stoneColour(ihash(c + seed + 59.0), depth) * lit, 1.0);
    }
  }
  return col;
}

// Sunken twigs: dark waterlogged sticks, some with a side branch, more near
// the banks.
const float TWIG_CELL = 26.0;
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
}
vec4 twigs(vec2 world, float depth, float shore) {
  float zone = (1.0 - smoothstep(0.4, 0.9, depth)) * mix(0.3, 1.0, shore);
  if (u_twigs <= 0.0 || zone <= 0.0) return vec4(0.0);
  vec2 seed = u_seedOffset + 811.0;
  ivec2 base = ivec2(floor(world / TWIG_CELL));
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      if (ihash(c + seed + 3.0) >= u_twigs * zone) continue;
      vec2 centre = (c + 0.1 + 0.8 * vec2(ihash(c + seed), ihash(c + seed + 71.0))) * TWIG_CELL;
      float a = ihash(c + seed + 7.0) * 6.2832;
      vec2 dir = vec2(cos(a), sin(a));
      float half_ = 4.0 + 7.0 * ihash(c + seed + 11.0);
      vec2 p0 = centre - dir * half_;
      vec2 p1 = centre + dir * half_;
      float w = 0.5 + 0.35 * ihash(c + seed + 13.0);
      float d = segment(world, p0, p1);
      if (ihash(c + seed + 17.0) < 0.6) {
        // A side branch from partway along.
        float t = 0.3 + 0.4 * ihash(c + seed + 19.0);
        float b = a + (ihash(c + seed + 23.0) < 0.5 ? 0.6 : -0.6);
        vec2 s0 = mix(p0, p1, t);
        d = min(d, segment(world, s0, s0 + vec2(cos(b), sin(b)) * half_ * 0.6) + 0.15);
      }
      if (d >= w) continue;
      vec3 wood = mix(vec3(0.15, 0.1, 0.06), vec3(0.24, 0.18, 0.11), ihash(c + seed + 29.0));
      return vec4(wood * (d < w * 0.4 ? 1.15 : 1.0), 1.0);
    }
  }
  return vec4(0.0);
}

void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  float e = texture(u_elev, (world / u_elevCell + 0.5) / u_elevDims).r;
  float d = texture(u_sdf, world / u_sdfExtent).r; // + water, - land

  float depth = clamp((u_landLevel - e) / u_landLevel, 0.0, 1.0);
  // Murky swamp water: olive-brown shallows to dark peaty green.
  vec3 shallow = vec3(0.31, 0.32, 0.19);
  vec3 mid = vec3(0.17, 0.21, 0.14);
  vec3 deep = vec3(0.06, 0.09, 0.08);
  vec3 water = depth < 0.5
    ? mix(shallow, mid, smoothstep(0.0, 0.5, depth))
    : mix(mid, deep, smoothstep(0.5, 1.0, depth));

  float grain = hash(floor(world / 3.0));
  vec3 land = mix(vec3(0.16, 0.13, 0.09), vec3(0.12, 0.17, 0.09), smoothstep(0.35, 0.7, fbm(world * 0.02)));
  land *= 0.92 + 0.1 * grain;
  land = mix(land, vec3(0.10, 0.09, 0.07), 1.0 - smoothstep(-6.0, 0.0, d)); // wet mud

  // Things on the floor are seen through the whole water column: the murk a
  // fish on the bottom gets, and a little more the deeper they lie. Stones,
  // then leaves and twigs on them, then sludge over everything.
  float murk = 1.0 - (1.0 - murkAt(depth)) * (1.0 - 0.5 * depth);
  float shore = 1.0 - smoothstep(0.0, 120.0, d);
  vec4 stone = stones(world, depth);
  water = mix(water, mix(stone.rgb, water, murk), stone.a);
  vec4 leaf = litter(world, depth, shore);
  water = mix(water, mix(leaf.rgb, water, murk), leaf.a);
  vec4 twig = twigs(world, depth, shore);
  water = mix(water, mix(twig.rgb, water, murk), twig.a);
  vec4 muck = sludge(world, depth);
  water = mix(water, mix(muck.rgb, water, murk), muck.a);

  float aa = max(fwidth(d), 0.5);
  // Alpha carries the water depth, for the murk on the fish (see boidFS).
  o = vec4(mix(land, water, smoothstep(-aa, aa, d)), depth);
}
`

// Pond scum, drawn over the fish in the same crisp pixel style as the plants:
// a carpet of small opaque duckweed fronds (one per jittered grid cell), dense
// where the mat is thick and thinning raggedly at its edges. Mats gather in the
// shallows and along the shore; colour varies regionally (lime, yellow-green,
// green, brownish) and per frond.
//
// The pattern is static, so it is baked once per map into a world-space
// texture with one texel per frond cell: rgb = frond colour, a = radius (0 =
// no frond). Each frame scumFS draws every frond as a rigid disc at its rest
// position plus its own drift (ScumField), so fronds move one by one and are
// never sheared or sliced.
const SCUM_FROND = /* glsl */ `
const float SCUM_CELL = 3.0; // px between fronds (ScumField texel size)
// Rest centre of the frond growing in cell c (cells in world space).
vec2 frondCentre(vec2 c, vec2 seed) {
  return (c + 0.15 + 0.7 * hash2(c + seed)) * SCUM_CELL;
}
`
export const scumBakeFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_elev;
uniform sampler2D u_sdf;
uniform float u_elevCell;
uniform vec2 u_elevDims;
uniform vec2 u_sdfExtent;
uniform float u_landLevel;
uniform vec2 u_seedOffset; // per-map noise offset
out vec4 o;
${NOISE}
${SCUM_FROND}
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 world = frondCentre(cell, u_seedOffset);
  o = vec4(0.0);
  float d = texture(u_sdf, world / u_sdfExtent).r;
  if (d < 0.0) return; // land
  float e = texture(u_elev, (world / u_elevCell + 0.5) / u_elevDims).r;
  float depth = clamp((u_landLevel - e) / u_landLevel, 0.0, 1.0);
  float shoreBoost = 1.0 - smoothstep(0.0, 40.0, d);
  float base = (1.0 - depth) * 0.75 + shoreBoost * 0.25 - 0.62;
  if (base + 0.96 < 0.35) return; // even maximal noise can't make a mat here

  vec2 mp = world + u_seedOffset;
  float cover = base + fbm(mp * 0.011) * 0.9 + (vnoise(mp * 0.07) - 0.5) * 0.14;
  float density = smoothstep(0.3, 0.52, cover);
  vec2 c = cell + u_seedOffset;
  if (density <= 0.0 || hash(c * 1.31 + 3.7) > density) return; // no frond in this cell

  // Regional mat colour.
  vec3 tone = mix(vec3(0.46, 0.53, 0.18), vec3(0.33, 0.45, 0.16), smoothstep(0.35, 0.65, fbm(mp * 0.006 + 20.0)));
  tone = mix(tone, vec3(0.42, 0.36, 0.17), smoothstep(0.55, 0.8, fbm(mp * 0.02 + 7.0)) * 0.7);
  float v = hash(c * 0.73 + 9.1);
  vec3 frond = tone * (0.78 + 0.4 * v);                         // per-frond shade
  frond = mix(frond, vec3(0.55, 0.62, 0.22), step(0.93, v) * 0.6); // a few bright young fronds
  float r = 1.25 + 0.75 * hash(c * 2.17 + 1.3);                  // overlapping -> solid mat cores
  o = vec4(frond, r / 2.5);
}
`

// The fronds of this frame: one point per frond cell in view, at its rest
// position plus its drift (ScumField), drawn as a rigid disc. Cells are drawn
// row by row, so where discs overlap the later cell covers the earlier one.
export const scumVS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_scumBake;
uniform sampler2D u_scumDisp; // frond drift in px, one texel per frond (ScumField)
uniform ivec2 u_firstCell;    // frond cell at the view's top-left
uniform int u_cols;           // frond cells per row drawn
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;          // world px per scene pixel
uniform vec2 u_seedOffset;
uniform float u_time;
flat out vec3 v_color;
flat out vec2 v_centre;
flat out float v_radius;
${NOISE}
${SCUM_FROND}
void main() {
  ivec2 c = u_firstCell + ivec2(gl_VertexID % u_cols, gl_VertexID / u_cols);
  vec4 f = vec4(0.0);
  if (all(greaterThanEqual(c, ivec2(0))) && all(lessThan(c, textureSize(u_scumBake, 0)))) f = texelFetch(u_scumBake, c, 0);
  gl_PointSize = 1.0;
  if (f.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // no frond here
  vec2 rest = frondCentre(vec2(c), u_seedOffset);
  vec2 drift = all(lessThan(c, textureSize(u_scumDisp, 0))) ? texelFetch(u_scumDisp, c, 0).xy : vec2(0.0);
  // Slow drift of the whole surface, the same across a frond so it stays rigid.
  vec2 wobble = vec2(sin(u_time * 0.07 + rest.y * 0.004), cos(u_time * 0.05 + rest.x * 0.004)) * 2.0;
  v_centre = rest + drift + wobble;
  float pixel = max(u_cell.x, u_cell.y);
  v_radius = max(f.a * 2.5, pixel * 0.6);
  v_color = f.rgb;
  vec2 uv = (v_centre - u_viewOffset) / u_view;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  gl_PointSize = ceil(2.0 * v_radius / pixel) + 1.0;
}
`
export const scumFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_sdf;
uniform vec2 u_sdfExtent;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;
flat in vec3 v_color;
flat in vec2 v_centre;
flat in float v_radius;
out vec4 o;
void main() {
  vec2 world = u_viewOffset + vec2(gl_FragCoord.x * u_cell.x, u_view.y - gl_FragCoord.y * u_cell.y);
  float dist = length(world - v_centre);
  if (dist >= v_radius) discard;
  if (texture(u_sdf, world / u_sdfExtent).r < 0.0) discard; // fronds never sit on land
  o = vec4(v_color * (1.05 - 0.2 * dist / v_radius), 1.0); // lighter centre; unshaded: scumCompositeFS shades it
}
`

// The scum is searched once per frame into a layer (scumFS); its shadow in
// the mask and its place in the scene are both read back from that layer.
// Shadow: a pixel is shadowed if the mat sits up-light of it, u_shift scene
// pixels away (scene y is up).
// The shadow lands on the floor, so it is offset by the floating height plus
// the water depth there: far out over deep water, close in the shallows. The
// floor softens and fades it with depth (shadeFloor).
export const scumShadowFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_scumLayer;
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;    // world px per scene pixel
uniform vec2 u_light;   // shadow offset per px of height
uniform float u_float;  // height of the mats above the water, px
out vec4 o;
const float LAND = ${LAND_LEVEL.toFixed(4)};
const float ELEV_PER_PX = ${LOG_ELEV_PER_PX.toFixed(6)};
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 dims = textureSize(u_scumLayer, 0);
  // Scene rows grow up the screen, world y grows down it.
  vec2 world = u_viewOffset + (vec2(q.x, dims.y - 1 - q.y) + 0.5) * u_cell;
  float floorE = texture(u_elev, (world / u_elevCell + 0.5) / u_elevDims).r;
  float depth = clamp((LAND - floorE) / LAND, 0.0, 1.0);
  vec2 shift = u_light * (u_float + depth * LAND / ELEV_PER_PX);
  ivec2 p = q - ivec2(int(round(shift.x / u_cell.x)), -int(round(shift.y / u_cell.y)));
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, dims))) discard;
  if (texelFetch(u_scumLayer, p, 0).a < 0.5) discard;
  o = vec4(0.0, 1.0, 0.0, 1.0);
}
`
// Silt stirred up from the floor (SiltField): a brown cloud low in the water,
// seen through the murk above it. Drawn over the floor, under the fish.
export const siltFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_silt;
uniform sampler2D u_background; // water colour + depth
uniform vec2 u_siltExtent;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
out vec4 o;
${TUNE}
void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  float d = texture(u_silt, world / u_siltExtent).r;
  if (d < 0.03) discard;
  vec4 water = texelFetch(u_background, ivec2(gl_FragCoord.xy), 0);
  // Fine mud: a dark grey with a little brown, barely tinted by the water.
  vec3 silt = mix(vec3(0.3, 0.28, 0.24), water.rgb, 0.15);
  float a = SILT_OPACITY * smoothstep(0.03, 0.7, d);
  o = vec4(silt * a, a);
}
`
export const scumCompositeFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_scumLayer;
out vec4 o;
${MASK}
void main() {
  vec4 c = texelFetch(u_scumLayer, ivec2(gl_FragCoord.xy), 0);
  if (c.a < 0.5) discard;
  o = vec4(c.rgb * shade(), 1.0);
}
`

// Plants: a fan of tapered blades from the base, plus a seed head for kinds
// that have one. Every vertex is generated from gl_VertexID, and the plant's
// data is pulled from a texture (plain draws, not instancing: with only ~20
// vertices per plant, instances would leave GPU warps half empty). Kind
// parameters come from uniform arrays. Blades bend with the GPU sway field
// (boids pushing through) plus a light idle breeze.
// Fallen trunks: one oriented quad per segment, pulled from the logs texture.
// Weathered wetland wood is pale silver-grey (bark long gone, sun-bleached),
// with long grain streaks, dark checks, a few remnant bark patches and moss
// along the top. Drawn in passes split at the water surface:
//   0  the submerged part, before the fish (it fades into the murk with depth)
//   1  the part above the water, over the plants (wet band at the waterline)
//   2  that part's shadow into the mask (quad lifted by each end's height)
export const logVS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
${LOGS}
uniform vec2 u_resolution;
uniform vec2 u_viewOffset;
uniform vec2 u_light; // shadow pass: projection per px of height (0 otherwise)
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
out vec2 v_world;
flat out int v_seg;
const vec2 Q[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(1, 1), vec2(0, -1), vec2(1, 1), vec2(0, 1));
void main() {
  int i = gl_InstanceID;
  v_seg = i;
  vec4 e = logEnds(i);
  vec4 sz = logSize(i);
  vec2 ab = e.zw - e.xy;
  float len = length(ab);
  vec2 dir = ab / len;
  vec2 q = Q[gl_VertexID];
  float rMax = max(sz.x, sz.y) + 2.0;
  float along = mix(-rMax, len + rMax, q.x); // room for round joints
  vec2 p = e.xy + dir * along + vec2(-dir.y, dir.x) * q.y * rMax;
  v_world = p;
  // Height of the trunk top above what its shadow falls on (water or ground).
  float t = clamp(along / len, 0.0, 1.0);
  float ground = max(texture(u_elev, ((e.xy + ab * t) / u_elevCell + 0.5) / u_elevDims).r, LOG_LAND);
  float h = max(mix(sz.z, sz.w, t) + mix(sz.x, sz.y, t) * LOG_ELEV_PER_PX - ground, 0.0) / LOG_ELEV_PER_PX;
  vec2 c = (p + u_light * h - u_viewOffset) / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}
`
export const logFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_world;
flat in int v_seg;
uniform int u_pass;          // 0 submerged, 1 above water, 2 shadow of the part above water
uniform vec3 u_sun;          // unit vector towards the sun
uniform sampler2D u_background; // water colour (rgb), for the murk
out vec4 o;
${MASK}
${NOISE}
${LOGS}
void main() {
  vec4 sec = logSection(v_seg, v_world);
  if (!logCovers(v_seg, sec)) discard;
  vec4 look = logLook(v_seg);
  float seed = look.x;
  float len = look.y;
  int endCode = int(look.z + 0.5);
  bool broken0 = endCode - (endCode / 3) * 3 == 1;
  bool broken1 = endCode / 3 == 1;
  float along = sec.x * len;
  // Splintered ends where the trunk or a branch broke off.
  float jag0 = broken0 ? 1.0 + 2.5 * vnoise(vec2(sec.y * 2.5, seed * 37.0 + look.w)) : -1e5;
  float jag1 = broken1 ? 1.0 + 3.0 * vnoise(vec2(sec.y * 3.0, seed * 53.0 + look.w + 5.0)) : -1e5;
  if (along < jag0 || along > len - jag1) discard;
  along += look.w; // distance along the whole trunk: grain runs on across joints
  // Slightly irregular outline.
  float edge = 1.0 - 0.1 * vnoise(vec2(along * 0.3, sign(sec.y) * 3.0 + seed * 11.0));
  if (abs(sec.y) > edge) discard;
  float s = sec.y / edge;
  float top = logTop(vec4(sec.x, s, sec.zw));
  bool above = top >= LOG_LAND;
  if ((u_pass == 0) == above) discard;
  if (u_pass == 2) { o = vec4(0.0, 0.0, 1.0, 1.0); return; }

  vec3 wood = mix(vec3(0.66, 0.64, 0.58), vec3(0.56, 0.51, 0.43), seed);  // silver-grey .. grey-tan
  wood *= 0.86 + 0.24 * vnoise(vec2(along * 0.05, s * 6.0 + seed * 9.0)); // long grain streaks
  float check = abs(vnoise(vec2(along * 0.08, s * 9.0 + seed * 5.0)) - 0.5);
  wood *= 1.0 - 0.38 * step(check, 0.035);                                  // dark checks along the grain
  float bark = smoothstep(0.6, 0.7, fbm(vec2(along * 0.04, s * 1.2) + seed * 23.0));
  wood = mix(wood, vec3(0.30, 0.25, 0.19), bark * 0.85);                    // remnant bark
  float moss = smoothstep(0.58, 0.75, fbm(vec2(along * 0.03, s) + seed * 41.0)) * (1.0 - abs(s));
  wood = mix(wood, vec3(0.34, 0.42, 0.18), moss * 0.75);
  // Paler end grain at the broken ends.
  float local = along - look.w;
  wood = mix(wood, vec3(0.74, 0.68, 0.55), max(step(local, jag0 + 1.2), step(len - jag1 - 1.2, local)));

  // Round trunk lit by the sun.
  vec4 ends = logEnds(v_seg);
  vec2 dir = normalize(ends.zw - ends.xy);
  vec3 n = vec3(vec2(-dir.y, dir.x) * s, sqrt(max(0.0, 1.0 - s * s)));
  vec3 c = wood * (0.7 + 0.45 * max(dot(n, u_sun), 0.0));

  if (u_pass == 1) {
    c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.012, top - LOG_LAND)); // wet at the waterline
    o = vec4(c * shadeTrunk(false), 1.0);
  } else {
    // Waterlogged and algae-stained, fading into the murk with depth.
    c *= vec3(0.78, 0.84, 0.7);
    vec4 water = texelFetch(u_background, ivec2(gl_FragCoord.xy), 0);
    // Like a fish at that depth, but steeper: wood fades fast in muddy water.
    float below = clamp((LOG_LAND - top) / LOG_LAND, 0.0, 1.0);
    float murk = mix(MURK_SURFACE, MURK_DEEP, sqrt(clamp(below * LOG_MURK, 0.0, 1.0)));
    // Shaded by plants and floating mats, never by trunks (they would shadow their own top).
    c = underWater(c, below, vec3(1.0, 1.0, 0.0), murk, water.rgb, water.a);
    o = vec4(c, 1.0);
  }
}
`
export const plantVS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
${TUNE}
uniform sampler2D u_plants; // 2 texels per plant: (x, y, scale, rotation), (kind, seed, brown, yellow)
uniform sampler2D u_bloom;  // 1 texel per plant: nectar left in its flower (0..1)
uniform int u_start;  // first plant of this batch
uniform int u_verts;  // vertices per plant in this batch
uniform vec2 u_resolution;
uniform vec2 u_viewOffset;
uniform float u_time;
uniform float u_pixel;
uniform sampler2D u_sway;
uniform vec2 u_swayExtent;
uniform vec4 u_kindShape[8];  // blades, minLen, maxLen, width
uniform vec3 u_kindBase[8];
uniform vec3 u_kindTip[8];
uniform vec4 u_kindHead[8];   // has head, length, width, -
uniform float u_kindSpread[8]; // fan angle
uniform float u_kindRegional[8]; // how much the regional palette applies
uniform int u_blades; // blades drawn for this batch (level of detail)
uniform vec2 u_light; // shadow pass: projection per px of height (0 in the colour pass)
uniform vec2 u_wind;  // unit vector the wind blows towards
uniform vec3 u_kindHeadColor[8];
out vec3 v_color;
out float v_t;
const float TAU = 6.28318530718;

const vec2 Q[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(1, 1), vec2(0, -1), vec2(1, 1), vec2(0, 1));

// Regional palettes seen from above in marshes (muted for the lo-fi look):
// live olive-green stands, yellow-green fresh growth / sedge, dry tan-brown reed.
const vec3 GREEN_BASE = vec3(0.19, 0.28, 0.11);
const vec3 GREEN_TIP = vec3(0.35, 0.42, 0.17);
const vec3 YELLOW_BASE = vec3(0.29, 0.33, 0.13);
const vec3 YELLOW_TIP = vec3(0.5, 0.52, 0.23);
const vec3 BROWN_BASE = vec3(0.29, 0.23, 0.14);
const vec3 BROWN_TIP = vec3(0.5, 0.42, 0.27);

float rnd(float n) { return fract(sin(n) * 43758.5453); }
vec4 toClip(vec2 p) {
  vec2 c = (p - u_viewOffset) / u_resolution * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}

void main() {
  int local = gl_VertexID / u_verts;
  int vid = gl_VertexID - local * u_verts;
  int texel = (u_start + local) * 2;
  int w = textureSize(u_plants, 0).x;
  vec4 a_pose = texelFetch(u_plants, ivec2(texel % w, texel / w), 0);
  vec4 a_info = texelFetch(u_plants, ivec2((texel + 1) % w, (texel + 1) / w), 0);
  int kind = int(a_info.x);
  float seed = a_info.y;
  vec2 base = a_pose.xy;
  float scale = a_pose.z;
  vec4 shape = u_kindShape[kind];
  float brown = a_info.z;
  float yellow = a_info.w;
  bool onLand = yellow >= ${LAND_FLAG.toFixed(1)}; // Vegetation.LAND_FLAG
  if (onLand) yellow -= ${LAND_FLAG.toFixed(1)};
  vec3 regionBase = mix(mix(GREEN_BASE, YELLOW_BASE, yellow), BROWN_BASE, brown);
  vec3 regionTip = mix(mix(GREEN_TIP, YELLOW_TIP, yellow), BROWN_TIP, brown);
  float regional = u_kindRegional[kind];

  vec2 push = texture(u_sway, base / u_swayExtent).xy;
  vec2 bend = push / (1.0 + length(push)) * PLANT_BEND; // saturating
  // Breeze: plants lean downwind in gusts that roll across the marsh with the
  // wind, plus a little sideways flutter.
  float gust = 0.5 + 0.5 * sin(u_time * 1.3 - dot(base, u_wind) * 0.012 + seed * 1.5);
  vec2 wind = BREEZE * (u_wind * (0.02 + 0.07 * gust)
    + vec2(-u_wind.y, u_wind.x) * sin(u_time * 2.1 + seed * TAU) * 0.02);
  vec2 lean = bend + wind; // tip displacement per unit of blade length

  // Plants are drawn in per-kind batches with exactly blades * 3 (+ 6 for a
  // head) vertices, so no vertices are wasted on unused blades.
  float blades = float(u_blades);
  int bladeVerts = u_blades * 3;
  vec2 p;
  if (vid < bladeVerts) {
    int b = vid / 3;
    int corner = vid - b * 3;
    float fb = float(b);
    // Blade 0 points along the plant's rotation; the rest alternate to either
    // side within the kind's fan angle.
    float slot = u_kindSpread[kind] / blades;
    float sgn = mod(fb, 2.0) == 1.0 ? 1.0 : -1.0;
    float ang = a_pose.w + (b == 0 ? 0.0 : sgn * ceil(fb * 0.5) * slot + (rnd(seed * 13.1 + fb) - 0.5) * slot * 0.6);
    float len = mix(shape.y, shape.z, b == 0 ? 1.0 : rnd(seed * 7.3 + fb * 1.7)) * scale;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 side = vec2(-dir.y, dir.x) * max(shape.w * scale, u_pixel * 0.8) * 0.5;
    float shade = 0.85 + 0.3 * rnd(seed * 3.1 + fb);
    if (corner == 2) {
      // Tips are highest, so their shadow lands furthest; bases stay put.
      p = base + dir * len + lean * len + u_light * len;
      v_color = mix(u_kindTip[kind], regionTip, regional) * shade;
      v_t = 1.0;
    } else {
      p = base + (corner == 0 ? side : -side);
      v_color = mix(u_kindBase[kind], regionBase, regional) * shade;
      v_t = 0.0;
    }
    if (onLand) {
      // On land the greenest greens lean to yellow, and plants (and their
      // blades) vary more in colour.
      v_color.r += max(v_color.g - v_color.r, 0.0) * 0.45;
      vec3 tint = vec3(rnd(seed * 5.7), rnd(seed * 9.1), rnd(seed * 2.3)) - 0.5;
      v_color *= 1.0 + tint * vec3(0.3, 0.2, 0.3) + (rnd(seed * 4.1 + fb * 2.9) - 0.5) * 0.16;
    }
  } else {
    vec4 head = u_kindHead[kind];
    if (head.x < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // Seed head along blade 0, from 55% of its length to its tip.
    vec2 q = Q[vid - bladeVerts];
    vec2 dir = vec2(cos(a_pose.w), sin(a_pose.w));
    float len = shape.z * scale;
    float along = mix(len - head.y * scale, len, q.x);
    float halfW = max(head.z * scale, u_pixel) * 0.5;
    p = base + dir * along + vec2(-dir.y, dir.x) * q.y * halfW + lean * along + u_light * along;
    // A flower drunk down by the midges fades towards a withered, leafy bud.
    int plant = u_start + local;
    int bw = textureSize(u_bloom, 0).x;
    float bloom = texelFetch(u_bloom, ivec2(plant % bw, plant / bw), 0).r;
    vec3 withered = mix(mix(u_kindTip[kind], regionTip, regional), vec3(0.42, 0.38, 0.26), 0.35);
    v_color = mix(withered, u_kindHeadColor[kind], smoothstep(0.0, 1.0, bloom)) * (0.9 + 0.2 * q.x);
    v_t = 1.0;
  }
  gl_Position = toClip(p);
}
`

export const plantFS = /* glsl */ `#version 300 es
precision mediump float;
in vec3 v_color;
in float v_t; // 0 at the base .. 1 at the tip
uniform int u_shadowPass; // 1: write the shadow mask
out vec4 o;
${MASK}
void main() {
  if (u_shadowPass == 1) { o = vec4(1.0, 0.0, 0.0, 1.0); return; }
  // Plants stand above the ground shadow: only their lower half is shaded,
  // and less deeply, so tops stay sunlit.
  float s = v_t < 0.5 && maskAt().r > 0.5 ? PLANT_SELF_SHADE : 1.0;
  o = vec4(v_color * s, 1.0);
}
`

// Light on the surface, coarse, for the midges' shade seeking (read back by
// the engine): plant, scum, pad and trunk shadows (the mask) times cloud
// shade. One texel per SHADE_CELL scene pixels, 1 = full sun.
export const shadeFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_shadowMask;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform bool u_cloudsOn;
out vec4 o;
${CLOUDS}
void main() {
  // Four taps across the texel's patch of the mask (scene y is up).
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 t = 0.25 / vec2(textureSize(u_shadowMask, 0)) * ${SHADE_CELL.toFixed(1)};
  float shadow = 0.0;
  for (int k = 0; k < 4; k++) {
    vec3 m = texture(u_shadowMask, uv + t * vec2(k % 2 == 0 ? -1.0 : 1.0, k < 2 ? -1.0 : 1.0)).rgb;
    shadow += max(max(m.r, m.g), m.b) * 0.25;
  }
  float light = mix(1.0, SHADOW, shadow);
  if (u_cloudsOn) light *= mix(1.0, CLOUD_SHADE, cloudCover(v_uv * u_view + u_viewOffset));
  o = vec4(light, 0.0, 0.0, 1.0);
}
`

// Midges (sim/Insects.js), their egg rafts and ripples: one point each, in
// scene pixels, by state (FLYING 0, ON_WATER 1, ON_FLOWER 2, FALLING 3,
// DEAD 4, EGGS 5, EMPTY 6, RIPPLE 7, DRAGONFLY 8, DRAGON_EGGS 9):
//   u_mode 0  on the water, under overhanging plants: a resting midge (2x2
//             body and four pale dimples where its legs press into the
//             surface), bodies, egg rafts (pale, darkening as they ripen) and
//             ripple rings
//   u_mode 1  in the air or perched on a flower: a 2x2 body; in flight a
//             wing now and then catches the light. The selected midge (a_look.w)
//             also gets a ring, wherever it is
//   u_mode 2  shadows on the floor, cast through the water (so the murk fades
//             them): a dot under a flying midge, and under one on the water the
//             dark rounded shadows of its leg dimples, larger than the dimples
export const insectVS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_body; // x, y, height above the water (px), state
layout(location = 1) in vec4 a_look; // seed, ripple age (s), egg maturity (0..1), selected (midges) / brood (rafts)
uniform int u_mode;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;  // world px per scene pixel
uniform vec2 u_light; // shadow offset per px of height
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
flat out vec3 v_look;
flat out float v_selected;
flat out float v_state;
flat out float v_size;
flat out float v_murk; // shadows: water depth for murkAt (-1 on land)
const float LAND = ${LAND_LEVEL.toFixed(4)};
const float ELEV_PER_PX = ${LOG_ELEV_PER_PX.toFixed(6)};
void main() {
  int state = int(a_body.w);
  // Point size per mode and state; 0 = not drawn in this mode.
  float size = 0.0;
  if (u_mode == 0) size = state == 1 ? 8.0 : state == 4 ? 2.0 : state == 5 ? 4.0 : state == 7 ? 16.0 : state == 9 ? 8.0 : 0.0;
  else if (u_mode == 1) size = state == 8 ? (mod(a_look.w, 2.0) > 0.5 ? 18.0 : 12.0) : state <= 2 && a_look.w > 0.5 ? 14.0 : state == 0 || state == 2 || state == 3 ? 2.0 : 0.0;
  else size = state == 1 ? 8.0 : state == 0 || state == 3 ? 2.0 : state == 8 ? 4.0 : 0.0;
  gl_PointSize = 1.0;
  if (size == 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 p = a_body.xy;
  v_murk = -1.0;
  if (u_mode == 2) {
    float floorE = texture(u_elev, (p / u_elevCell + 0.5) / u_elevDims).r;
    float water = clamp(LAND - floorE, 0.0, LAND);
    p += u_light * (a_body.z + water / ELEV_PER_PX);
    v_murk = water > 0.0 ? water / LAND : -1.0;
  }
  // Snapped to the pixel grid: every size is even, so the centre is a pixel corner.
  vec2 low = u_view / u_cell;
  vec2 centre = floor((p - u_viewOffset) / u_cell) + 1.0;
  vec2 uv = centre / low;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  gl_PointSize = size;
  v_size = size;
  v_look = a_look.xyz;
  // a_look.w: selected (midges, dragonflies) or eggs in the clutch (dragonfly eggs).
  v_selected = state <= 2 || state >= 8 ? a_look.w : 0.0;
  v_state = float(state);
}
`

// Motion trails of flying insects (engine/InsectWorld.js builds them): lines
// through each one's last few positions, in scene pixels like insectVS, with
// premultiplied colours fading towards the tail.
export const trailVS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_colour;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;
out vec4 v_colour;
void main() {
  vec2 uv = ((a_pos - u_viewOffset) / u_cell + 0.5) / (u_view / u_cell);
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  v_colour = a_colour;
}
`

export const trailFS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_colour;
out vec4 o;
void main() {
  o = v_colour;
}
`

export const insectFS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
flat in vec3 v_look;
flat in float v_selected;
flat in float v_state;
flat in float v_size;
flat in float v_murk;
uniform int u_mode;
uniform float u_time;
out vec4 o;
${TUNE}
const float RIPPLE_LIFE = ${RIPPLE_LIFE.toFixed(2)}; // s (Insects.js)
const vec2 LEGS[4] = vec2[4](vec2(-2.5, -1.5), vec2(2.5, -1.5), vec2(-2.5, 1.5), vec2(2.5, 1.5));
vec4 premul(vec3 c, float a) { return vec4(c * a, a); }
void main() {
  vec2 lp = (gl_PointCoord - 0.5) * v_size; // scene px from the centre; pixel centres at +-0.5, +-1.5, ...
  float seed = v_look.x;
  int state = int(v_state);
  vec3 body = mix(vec3(0.04, 0.035, 0.03), vec3(0.2, 0.13, 0.07), seed); // black to brown
  if (u_mode == 2) {
    float murk = v_murk < 0.0 ? 0.0 : murkAt(v_murk);
    float a = (1.0 - SHADOW) * (1.0 - murk);
    if (state == 1) {
      // Dimple shadows: a rounded dark spot under each leg.
      float d = 1e3;
      for (int k = 0; k < 4; k++) d = min(d, length(lp - LEGS[k] * vec2(0.8, 1.2)));
      if (d > 1.3) discard;
      a *= 0.9;
    } else if (state == 8) {
      if (length(lp) > 1.6) discard;
      a *= 0.6; // a dragonfly's shadow
    } else a *= 0.45; // the speck of a flying midge's shadow
    o = premul(vec3(0.0, 0.02, 0.05), a);
    return;
  }
  if (u_mode == 1 && (state == 8 ? mod(v_selected, 2.0) : v_selected) > 0.5) {
    // The selected midge: an amber ring around it (its body is drawn here too,
    // except on the water where mode 0 draws it).
    float r = length(lp);
    if (abs(r - (state == 8 ? 7.5 : 5.5)) < 0.75) { o = vec4(0.98, 0.75, 0.25, 1.0); return; }
    if (state != 8) {
      if (state != 1 && all(lessThan(abs(lp), vec2(1.0)))) { o = vec4(body, 1.0); return; }
      discard;
    }
  }
  if (state == 8) {
    // A dragonfly from above: a slim body along its heading (v_look.y) in its
    // inherited colour (v_look.z: 8-bit r, g, b packed), a darker head, and
    // two pairs of glassy wings that flicker.
    float h = v_look.y;
    vec2 q = vec2(dot(lp, vec2(cos(h), sin(h))), dot(lp, vec2(-sin(h), cos(h))));
    if (abs(q.y) < 0.75 && q.x > -5.0 && q.x < 3.5) {
      float c = v_look.z;
      float cr = floor(c / 65536.0);
      float cg = floor((c - cr * 65536.0) / 256.0);
      vec3 colour = vec3(cr, cg, c - cr * 65536.0 - cg * 256.0) / 255.0;
      o = vec4(q.x > 2.0 ? colour * 0.35 : colour, 1.0);
      return;
    }
    // Perched (v_selected >= 2) the wings are held still, spread flat.
    float beat = v_selected >= 1.5 ? 0.3 : 0.5 + 0.5 * sin(u_time * 60.0 + seed * 40.0);
    if ((abs(q.x - 1.2) < 0.9 || abs(q.x + 0.6) < 0.9) && abs(q.y) < 4.5 + beat) {
      o = premul(vec3(0.82, 0.88, 0.92), 0.35 + 0.2 * beat);
      return;
    }
    discard;
  }
  if (u_mode == 1) {
    // In flight a wing catches the light now and then: one pixel of the top row flashes pale.
    if (state == 0 && lp.y < 0.0) {
      float t = u_time * 4.0 + seed * 17.0;
      bool left = lp.x < 0.0;
      if (fract(t) > 0.88 && left == (fract(seed * 31.0 + floor(t) * 0.37) < 0.5)) {
        o = vec4(0.72, 0.72, 0.66, 1.0);
        return;
      }
    }
    o = vec4(body, 1.0);
    return;
  }
  if (state == 7) {
    // A ripple ring spreading from a touch-down, twitch, take-off, dip or hatching.
    float age = v_look.y;
    float r = 1.5 + age / RIPPLE_LIFE * 5.5;
    if (abs(length(lp) - r) >= 0.5) discard;
    o = premul(vec3(0.75, 0.8, 0.7), 0.4 * (1.0 - age / RIPPLE_LIFE));
    return;
  }
  if (state == 9) {
    // A dragonfly clutch: a short wavy string of up to four plump eggs on the
    // water (v_selected carries how many), amber-cream, browning as they ripen.
    vec2 q = mat2(cos(seed * 6.28), -sin(seed * 6.28), sin(seed * 6.28), cos(seed * 6.28)) * lp;
    float n = clamp(v_selected, 1.0, 4.0);
    for (int k = 0; k < 4; k++) {
      if (float(k) >= n) break;
      vec2 c = vec2(-2.4 + float(k) * 1.6, mod(float(k), 2.0) * 0.9 - 0.45);
      if (length(q - c) < 0.95) {
        o = premul(mix(vec3(0.86, 0.74, 0.42), vec3(0.42, 0.3, 0.16), v_look.z), 0.95);
        return;
      }
    }
    discard;
  }
  if (state == 5) {
    // Egg raft: three pale eggs in a clump, darkening as the larvae grow.
    ivec2 px = ivec2(floor(lp + 2.0)); // 0..3
    int skip = int(seed * 4.0);
    ivec2 q = px - 1;
    if (any(lessThan(q, ivec2(0))) || any(greaterThan(q, ivec2(1))) || q.x + 2 * q.y == skip) discard;
    vec3 c = mix(vec3(0.78, 0.74, 0.56), vec3(0.3, 0.27, 0.2), v_look.z);
    o = premul(c, 0.9);
    return;
  }
  if (state == 4) {
    o = vec4(mix(body, vec3(0.3, 0.28, 0.24), 0.35), 1.0); // a body, dulled
    return;
  }
  // Resting on the water.
  if (all(lessThan(abs(lp), vec2(1.0)))) { o = vec4(body, 1.0); return; }
  for (int k = 0; k < 4; k++) {
    if (all(lessThan(abs(lp - LEGS[k]), vec2(0.5)))) {
      o = premul(vec3(0.8, 0.84, 0.72), 0.7); // light caught in the dimple
      return;
    }
  }
  discard;
}
`

// Lily pads: a disc with a wedge notch, veins and an optional flower.
export const padVS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 a_pad;  // x, y, radius, angle
layout(location = 1) in vec4 a_look; // seed, flower, -, -
uniform vec2 u_resolution;
uniform vec2 u_viewOffset;
uniform vec2 u_shift;
uniform vec2 u_light; // shadow pass: offset per px of water below (0 otherwise)
uniform float u_time;
uniform sampler2D u_sway;
uniform vec2 u_swayExtent;
uniform sampler2D u_elev;
uniform float u_elevCell;
uniform vec2 u_elevDims;
out vec2 v_local;
out vec2 v_look;
const float LAND = ${LAND_LEVEL.toFixed(4)};
const float ELEV_PER_PX = ${LOG_ELEV_PER_PX.toFixed(6)};

const vec2 Q[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 corner = Q[gl_VertexID];
  // Anchored by the stem: bob gently and get nudged by passing fish.
  float seed = a_look.x * 40.0;
  vec2 push = texture(u_sway, a_pad.xy / u_swayExtent).xy;
  vec2 offset = push / (1.0 + length(push)) * a_pad.z * 1.2
    + vec2(sin(u_time * 0.6 + seed), cos(u_time * 0.5 + seed * 1.3)) * a_pad.z * 0.08;
  float angle = a_pad.w + 0.15 * sin(u_time * 0.4 + seed) + push.x * 0.4;
  float c = cos(angle);
  float s = sin(angle);
  v_local = vec2(c * corner.x + s * corner.y, -s * corner.x + c * corner.y);
  v_look = a_look.xy;
  // Shadow pass: the shadow falls on the floor, as far below as the water is deep.
  float floorE = texture(u_elev, (a_pad.xy / u_elevCell + 0.5) / u_elevDims).r;
  vec2 p = a_pad.xy + offset + corner * a_pad.z + u_shift + u_light * clamp(LAND - floorE, 0.0, LAND) / ELEV_PER_PX;
  vec2 clip = (p - u_viewOffset) / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`

export const padFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_look;
uniform int u_shadowPass; // 1: write the pad's shadow into the mask
out vec4 o;
${MASK}

void main() {
  float d = length(v_local);
  float a = atan(v_local.y, v_local.x);
  if (d > 1.0) discard;
  if (abs(a) < 0.28 && d > 0.06) discard; // notch

  if (u_shadowPass == 1) { o = vec4(0.0, 1.0, 0.0, 1.0); return; }

  float seed = v_look.x;
  vec3 col = mix(vec3(0.25, 0.41, 0.21), vec3(0.34, 0.49, 0.25), seed);
  col *= 0.88 + 0.12 * (1.0 - d);                         // lighter centre
  col *= 1.0 - 0.12 * smoothstep(0.82, 0.95, d);          // darker rim
  col *= 1.0 - 0.1 * step(0.94, abs(sin(a * 4.5 + seed * 6.0))) * step(0.15, d); // veins

  if (v_look.y > 0.5) {
    float petals = 0.42 * (0.65 + 0.35 * abs(cos(a * 4.0 + seed * 3.0)));
    if (d < petals) col = mix(vec3(0.86, 0.62, 0.68), vec3(0.93, 0.86, 0.84), d / petals);
    if (d < 0.11) col = vec3(0.86, 0.72, 0.30);
  }
  o = vec4(col * shade(), 1.0);
}
`

// --- Animated water --------------------------------------------------------
// Shared by the floor and surface passes: wind-driven wavelets whose crests
// run across the wind and travel downwind, bent by slow noise so they are not
// ruler-straight. Phase in radians; sin(phase) = 1 on a crest.
const RIPPLES = /* glsl */ `
const float TAU = 6.28318530718;
float ripplePhase(vec2 world, float time) {
  float bend = cloud(world / 140.0 - u_wind * time * 0.004) + cloud(world / 45.0 + 0.3) * 0.35;
  return dot(world, u_wind) * TAU / RIPPLE_WAVELENGTH - time * RIPPLE_SPEED + bend * 18.0;
}
`

// Pond floor, per frame: the cached water/land image, animated, with the
// shadows applied (replaces blitting the cache and darkening it).
//  - Deep water: a very faint swirl, slow eddies of suspended silt.
//  - Shallow water: caustics, the web of light the rippled surface focuses on
//    the floor, in two hard brightness bands; only where the sun reaches the
//    floor (not under plant/scum shadows or clouds). The floor seen through
//    the ripples also wobbles by up to a pixel (refraction).
export const waterFloorFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_background; // static water colour (rgb) + water depth (a)
uniform sampler2D u_sdf;
uniform vec2 u_sdfExtent;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform float u_time;
uniform bool u_cloudsOn;
uniform float u_windStrength; // 0.4 (calm) .. 1 (windy)
out vec4 o;
${MASK}
${CLOUDS}
${RIPPLES}
const vec3 CAUSTIC_LIGHT = vec3(1.0, 0.95, 0.75);

// Silt: noise warped twice by noise that itself drifts, so it curls.
float swirl(vec2 world) {
  float t = u_time * SWIRL_SPEED;
  vec2 p = world / SWIRL_SCALE - u_wind * t * 0.5;
  vec2 w1 = vec2(cloud(p * 0.7 + vec2(t, 0.31)), cloud(p * 0.7 + vec2(0.63, -t))) - 0.5;
  vec2 q = p + w1 * 0.6;
  vec2 w2 = vec2(cloud(q * 1.3 + 0.2 - t * 0.7), cloud(q * 1.3 + 0.8 + t * 0.7)) - 0.5;
  return cloud(q * 2.0 + w2 * 0.8) - 0.5; // about -0.3 .. 0.3
}

// 0, 1 or 2: brightness band of the caustic web here.
float caustics(vec2 world) {
  vec2 p = world / CAUSTIC_SCALE;
  float t = u_time * CAUSTIC_SPEED;
  // One layer whose ridges (noise = 0.5) are the bright lines, wobbled by a
  // second, slower layer so the web shimmers instead of sliding.
  vec2 wobble = vec2(cloud(p * 0.8 + vec2(-0.6, 0.8) * t + 0.5), cloud(p * 0.8 + vec2(0.7, 0.5) * t + 0.2)) - 0.5;
  float a = cloud(p + vec2(0.9, 0.5) * t + wobble * 0.12);
  float r = 1.0 - abs(2.0 * a - 1.0);
  return step(0.95, r) + step(0.985, r);
}

void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 bg = texelFetch(u_background, px, 0);
  if (texture(u_sdf, world / u_sdfExtent).r < 0.0) { o = vec4(bg.rgb * shadeAll(), 1.0); return; } // land

  float depth = bg.a;
  float s = shadeFloor(depth);
  vec3 c = bg.rgb;
  float shallow = 1.0 - smoothstep(0.12, 0.45, depth); // where ripples show
  if (shallow > 0.0) {
    // Refraction: the floor shifts with the ripple slope (scene y is flipped).
    float slope = cos(ripplePhase(world, u_time)) * shallow * u_windStrength;
    ivec2 off = ivec2(round(u_wind * slope * REFRACTION * vec2(1.0, -1.0)));
    vec4 moved = texelFetch(u_background, clamp(px + off, ivec2(0), textureSize(u_background, 0) - 1), 0);
    if (moved.a > 0.0) c = moved.rgb; // never pull in land colour
  }
  // Caustics fade out towards CAUSTIC_DEPTH.
  float reach = 1.0 - smoothstep(CAUSTIC_DEPTH * 0.35, CAUSTIC_DEPTH, depth);
  if (reach > 0.0 && s > 0.99) {
    float sun = u_cloudsOn ? 1.0 - cloudCover(world) : 1.0;
    float band = caustics(world) * step(0.5, sun);
    c += CAUSTIC_LIGHT * band * CAUSTIC_STEP * reach; // additive light
  }
  float deep = smoothstep(0.3, 0.85, depth);
  if (deep > 0.0) {
    float silt = swirl(world) * deep;
    c *= 1.0 + silt * SWIRL_STRENGTH * 3.3; // silt is about -0.3 .. 0.3
    c = mix(c, c * vec3(1.06, 1.02, 0.9), max(silt, 0.0) * 1.5); // lifted silt is browner
  }
  o = vec4(c * s, 1.0);
}
`

// Pond surface, over the fish: short pale glints on the ripple crests in the
// shallows. Crests are broken into dashes by noise stretched along them.
// Fish stir the water (sway field): glints get denser and brighter there.
// Calmer wind (lower cloud speed) and clouds (no sun) mute them.
export const waterSurfaceFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_background; // water depth in alpha
uniform sampler2D u_sdf;        // surface SDF: shore and trunks breaking the surface
uniform sampler2D u_sway;
uniform vec2 u_sdfExtent;
uniform vec2 u_swayExtent;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform float u_time;
uniform bool u_cloudsOn;
uniform float u_windStrength;
out vec4 o;
${CLOUDS}
${RIPPLES}
const vec3 GLINT = vec3(0.82, 0.86, 0.8);

// Shallow ripples: sparse glints on the crests, livelier in fish wakes.
float shallowRipples(vec2 world, float depth) {
  float shallow = 1.0 - smoothstep(0.1, 0.4, depth);
  if (shallow <= 0.0) return 0.0;
  float wake = clamp(length(texture(u_sway, world / u_swayExtent).xy) * 0.6, 0.0, 1.0);
  float crest = sin(ripplePhase(world, u_time));
  if (crest < 0.86 - 0.12 * wake) return 0.0;
  vec2 across = vec2(-u_wind.y, u_wind.x);
  float dash = cloud(vec2(dot(world, u_wind) / 40.0, dot(world, across) / 90.0) - vec2(u_time * 0.02, 0.0));
  if (dash < 0.68 - 0.18 * u_windStrength - 0.25 * wake) return 0.0;
  return RIPPLE_ALPHA * min(1.0, shallow * 1.5) * u_windStrength * (1.0 + wake);
}

void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  float sdf = texture(u_sdf, world / u_sdfExtent).r;
  if (sdf < 1.0) discard; // land, trunks and the shoreline itself
  float depth = texelFetch(u_background, ivec2(gl_FragCoord.xy), 0).a;
  float a = shallowRipples(world, depth);
  if (a <= 0.0) discard;
  a *= u_cloudsOn ? 1.0 - 0.75 * cloudCover(world) : 1.0;
  o = vec4(GLINT * a, a);
}
`

// Darkens the (cached, unshaded) water and land under the shadow mask.
export const shadowFS = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_background; // water depth in alpha (0 on land)
out vec4 o;
${MASK}
void main() {
  float s = shadeFloor(texelFetch(u_background, ivec2(gl_FragCoord.xy), 0).a);
  if (s > 0.99) discard;
  o = vec4(0.0, 0.0, 0.0, 1.0 - s); // premultiplied: dst * s
}
`

// Cloud shadows, ordered (Bayer) dithering of the scene to a reduced colour
// depth, and a soft vignette. The canvas is scene-sized: one fragment per
// scene pixel; the browser upscales it with hard pixel edges.
// Clouds shade everything (water, fish, plants), so they are applied here, to
// the finished scene (see CLOUDS). The dithering below keeps them pixelated.
export const postFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_scene;
uniform ivec2 u_low;     // scene size in pixels
uniform float u_levels;
uniform bool u_cloudsOn;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;       // world px per scene pixel
out vec4 o;
${CLOUDS}
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(u_scene, t, 0).rgb;
  // Scene row 0 is the bottom of the screen; world y grows downwards.
  vec2 world = u_viewOffset + (vec2(t.x, u_low.y - 1 - t.y) + 0.5) * u_cell;
  if (u_cloudsOn) c *= mix(1.0, CLOUD_SHADE, cloudCover(world));


  float b = mix(0.5, BAYER[(t.x & 3) + (t.y & 3) * 4] / 16.0, DITHER);
  c = floor(c * u_levels + b) / u_levels;

  vec2 q = gl_FragCoord.xy / vec2(u_low) - 0.5;
  c *= 1.0 - VIGNETTE * dot(q, q);
  o = vec4(c, 1.0);
}
`
