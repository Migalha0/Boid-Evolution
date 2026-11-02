import { LOG_ELEV_PER_PX } from '../sim/Logs.js'
import { LAND_LEVEL } from '../sim/PondMap.js'
/** Seconds a ripple ring lasts (insectFS). */
const RIPPLE_LIFE = 0.9
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
layout(std140) uniform Tunables { highp vec4 u_tune[8]; };
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
#define DEPTH_EFFECT u_tune[7].x      // 1 = as set; higher: things fade and darken sooner with depth
// How far something at this depth (0 = surface .. 1 = deepest floor) has
// faded into the water: fish, the floor, and the shadows on it alike;
// DEPTH_EFFECT strengthens it (what is left of the view, raised to it).
float murkAt(float depth) { return 1.0 - pow(1.0 - mix(MURK_SURFACE, MURK_DEEP, depth), DEPTH_EFFECT); }
// Depth as the water's colour shows it: deeper sooner with DEPTH_EFFECT.
float depthLook(float depth) { return 1.0 - pow(1.0 - depth, DEPTH_EFFECT); }
#endif
`


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
uniform vec4 u_windPair;     // the two fixed directions the wind is between (A.xy, B.xy)
uniform float u_windMix;     // how far from A to B it is, 0..1
uniform vec2 u_windTravel;   // how far the wind has blown (integral of u_wind dt, s)
uniform vec2 u_causticShift; // how far the caustics have drifted downwind (caustic noise tiles)

float cloud(vec2 p) { return texture(u_clouds, p).r; }

// Patterns stretched or travelling along the wind (cloud wisps, ripples)
// are drawn for two fixed directions, A and B, and cross-faded by u_windMix.
// Turning the wind never rotates a pattern (a turn about the origin would
// sweep it across the screen) or switches one abruptly: the old direction's
// fades out as the new one's fades in, continuously.
vec2 windA() { return u_windPair.xy; }
vec2 windB() { return u_windPair.zw; }
// Mixing two independent waves lowers their amplitude mid-fade; dividing by
// this keeps crests as tall.
float windMixNorm() { float w = u_windMix; return inversesqrt(w * w + (1.0 - w) * (1.0 - w)); }

// Wisps along the wind direction wd: 0 torn away .. 1 whole.
float cloudStreak(vec2 p, vec2 s, vec2 wd) {
  vec2 along = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));
  float streak = cloud(vec2(along.x * 3.0, along.y * 15.0) - dot(s, wd) * 3.6 + 0.5);
  return smoothstep(0.3, 0.7, streak);
}

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
  float streak = mix(cloudStreak(p, s, windA()), cloudStreak(p, s, windB()), u_windMix);
  return d * mix(streak, 1.0, d * d);
}
`

// Koi palette: gold, blue, white, orange, black (order = BOID_COLORS in species/fish.js).
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
// The selected fish (-1: none): the fish it sees (within u_focusRange and
// its field of view, as the sim's consider() tests) are lit up.
uniform int u_focusId;
uniform float u_focusRange;
uniform float u_focusCosFov;
out vec4 v_color;
out float v_swimDepth; // 0 = at the surface .. 1 = on the bottom; < 0 = not murked
out vec2 v_world;
out float v_blur;   // 0 = crisp .. 1 = deep fish, out of focus
out vec3 v_body;    // body: (along, across from the spine, half-width there), in body sizes
out float v_halo;   // how far the blur reaches past the outline (body sizes; 0 = crisp)
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
  v_halo = 0.0;
  vec2 f, r; float m;
  basisFrom(s.zw, f, r, m);
  // Where it swims now, rising over or diving under trunks (the sim's aux.z fraction).
  float swim = fract(aux.z);
  float floorE = texture(u_elev, (s.xy / u_elevCell + 0.5) / u_elevDims).r;
  float depth = clamp((LAND - floorE) / LAND, 0.0, 1.0); // water depth here, 0..1
  // Deep fish are out of focus: the mesh grows by the blur's reach past the
  // true outline (on every side, the snout too) and boidFS fades the halo
  // out by the distance to that outline. The shape itself never widens.
  if (u_mode == 0) {
    v_blur = DEEP_FADE * smoothstep(0.1, 0.7, swim * depth);
    v_halo = v_blur * max(0.4, 2.0 * u_pixel / max(u_size, 1e-3));
  }
  vec2 local;
  float half_;
  if (gl_VertexID < 24) {
    int seg = gl_VertexID / 6;
    vec2 q = Q[gl_VertexID - seg * 6];
    int node = seg + int(q.x);
    half_ = WIDTH[node];
    local = vec2(SPINE[node] + (node == 0 ? v_halo : 0.0), (half_ + v_halo) * q.y);
  } else {
    local = FIN[gl_VertexID - 24];
    // At least a pixel wide, so the slit never breaks up into dots.
    half_ = max(abs(local.y), 0.5 * u_pixel / max(u_size, 1e-3));
    local.y = sign(local.y) * (half_ + v_halo);
    if (local.x < -1.7) local.x -= v_halo;
  }
  v_body = vec3(local, half_);
  // Travelling wave from head to tail; amplitude ~ (distance from nose)^2.
  float back = (1.6 - local.x) / 3.35;
  float phase = aux.w + traits.z * 6.2832;
  local.y += SWIM_WIGGLE * 1.6 * back * back * sin(phase - back * 4.0);
  // Turning: the body bends into an arc around the turn centre.
  float turn = clamp(dot(aux.xy, r) / max(u_maxForce, 1.0), -1.0, 1.0);
  local.y += turn * 0.07 * (local.x - 0.3) * (local.x - 0.3);
  // Deeper is further from the eye: a little smaller.
  vec2 p = s.xy + (f * local.x + r * local.y) * u_size * (1.0 - 0.12 * v_blur) + u_shift;
  if (u_mode == 0) {
    vec3 c = PALETTE[clamp(int(traits.x), 0, 4)];
    if (u_focusId >= 0 && boidId() != u_focusId) {
      vec4 fs = texelFetch(u_state, coordOf(u_focusId), 0);
      vec2 d = s.xy - fs.xy;
      float d2 = dot(d, d);
      vec2 fh = length(fs.zw) > 0.0 ? normalize(fs.zw) : vec2(1.0, 0.0);
      if (d2 <= u_focusRange * u_focusRange && dot(d, fh) >= u_focusCosFov * sqrt(d2)) c = mix(c, vec3(1.0, 0.95, 0.75), 0.6);
    }
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

// Silt stirred up from the floor (SiltField), as seen: a haze of fine
// sediment a little lighter and muddier than the water there, low in the
// water so it is seen through nearly the whole column above it (murked like
// the floor), thin at its fringe. d: cloud density; water: the water's
// colour there, depth: its depth (0..1). Needs TUNE.
const SILT_LOOK = /* glsl */ `
vec4 siltLook(float d, vec3 water, float depth) {
  vec3 mud = mix(water * 1.3, vec3(0.45, 0.41, 0.32), 0.35);
  vec3 c = mix(mud, water, murkAt(depth * 0.8) * 0.7);
  float a = SILT_OPACITY * smoothstep(0.02, 0.45, d) * 0.85;
  return vec4(c, a);
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
in float v_blur;
in vec3 v_body;
in float v_halo;
in vec2 v_soft;
uniform sampler2D u_background;
uniform highp sampler2D u_trunks; // baked trunk map (MapTextures): r = trunk top elevation, -1 = none
uniform sampler2D u_silt;         // stirred silt density (SiltField)
uniform vec2 u_siltExtent;
out vec4 o;
${MASK}
${SILT_LOOK}
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
    // Out of focus, it takes on more of the water's colour too.
    c = underWater(c, below, vec3(1.0), min(1.0, murkAt(below) + 0.25 * v_blur), water.rgb, water.a);
    // Swimming low, inside a silt cloud it stirred: veiled by it like the floor.
    if (SILT_OPACITY > 0.0 && v_swimDepth > 0.45) {
      vec4 cloud = siltLook(texture(u_silt, v_world / u_siltExtent).r, water.rgb, water.a);
      c = mix(c, cloud.rgb, cloud.a * smoothstep(0.45, 0.9, v_swimDepth));
    }
  } else c *= shadeAll();
  // Shadows fade out at their rim. A deep fish is out of focus: from a little
  // inside its true outline to the blur's reach outside it, it fades out (by
  // the distance to the outline: across the body, past the snout and the
  // fin's end), as soft all round as a blurred shape; dithering keeps it
  // pixelated.
  float alpha = v_color.a * (1.0 - smoothstep(0.1, 1.0, length(v_soft)));
  if (v_halo > 0.0) {
    float out_ = max(abs(v_body.y) - v_body.z, max(v_body.x - 1.6, -1.75 - v_body.x));
    alpha *= 1.0 - smoothstep(-0.6 * v_halo, v_halo, out_);
  }
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
// A species whose range is a gene (midges): the radius from u_rangeTex's red
// channel per boid; one with modes: only the living (aux.y 0 flying, 2 perched).
uniform highp sampler2D u_rangeTex;
uniform int u_rangeFromTex;
uniform int u_rangeStride; // texels per boid in u_rangeTex (the genes: BoidKernel geneTexels)
uniform int u_aliveCheck;
uniform int u_rings;
uniform float u_band;      // ring band half-width, world px
uniform float u_halfSpan;  // half the FOV arc, radians (slightly padded)
uniform float u_sepRatio;
out vec2 v_local; // boid frame: x = forward, y = right, unit = radius
void main() {
  vec4 s = boidState();
  ivec2 rc = coordOf(boidId());
  float RR = max(u_rangeFromTex == 1 ? texelFetch(u_rangeTex, ivec2(rc.x * u_rangeStride, rc.y), 0).r : u_radius, 0.0);
  float mode = boidAux().y;
  if (u_aliveCheck == 1 && mode != 0.0 && mode != 2.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_local = vec2(0.0); return; }
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
    float R = (ring == 0 ? 1.0 : u_sepRatio) * RR;
    // The outer edge is pushed out so the straight chord still covers the arc.
    float rad = q.y < 0.0 ? max(R - 2.0 * u_band, 0.0) : (R + u_band) / cos(segAngle * 0.5);
    v_local = vec2(cos(a), sin(a)) * rad / RR;
    corner = f * v_local.x + r * v_local.y;
  }
  gl_Position = toClip(s.xy + corner * RR);
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
  float rim = smoothstep(1.0 - aa * 1.5, 1.0 - aa * 0.3, d) * outer; // a thin line, as the insects' range rings
  float sepRing = 1.0 - smoothstep(0.0, aa, abs(d - u_sepRatio));

  float a = inFov * (u_fill * outer + u_rim * rim + u_rim * 0.5 * sepRing);
  if (a < 0.002) discard; // spare the blender the (mostly empty) interior
  o = vec4(u_color * a, a);
}
`

// Fullscreen triangle for the screen-space passes (water, shadows, post...), with
// uv over a world extent (u_uvScale, u_uvOffset).
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
uniform vec3 u_sun;        // unit vector towards the sun
uniform vec2 u_light;      // shadow offset per px of height, away from the sun
uniform sampler2D u_tint;  // the plants' colour regions: r brown, g yellow
uniform float u_waterTint; // 0 blue-green .. 1 muddy brown water
uniform highp sampler2D u_trunks; // baked trunk map (MapTextures): g = distance to the nearest trunk side
uniform float u_tintCell;
uniform vec2 u_tintDims;
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

vec2 sunDir() { return normalize(u_sun.xy + vec2(1e-4, 0.0)); } // along the floor, towards the sun

// Sludge on the floor: a slimy mat of algae and decaying weed in patches
// across the shallow-to-middle depths, laid out in strands along a slow
// current (one direction per map, bent by a broad warp), so it reads as
// streaky and combed rather than clumped. Inside a patch the strands merge
// into a mat; towards its edge only the thickest strands carry on, trailing
// off along the current. Colour wanders between olive, dark green, rotting
// brown and yellowish slime, regionally and strand by strand; thicker mat is
// darker, strand crests lighter, and the thin fringe lets the floor show
// through. Baked with the background (no cost per frame).
float sludgeZone(float depth) { return smoothstep(0.06, 0.18, depth) * (1.0 - smoothstep(0.45, 0.75, depth)); }
// Patches: broad warped noise at p (world + seed); sludge where it is above the level.
float sludgePatches(vec2 p) { return fbm(p * 0.0045 + vec2(fbm(p * 0.011 + 3.1), fbm(p * 0.011 + 8.7)) * 0.9); }
float sludgeLevel(float zone) { return mix(0.78, 0.38, SLUDGE) + (1.0 - zone) * 0.25; }
vec4 sludge(vec2 world, float depth) {
  float zone = sludgeZone(depth);
  if (zone <= 0.0 || SLUDGE <= 0.0) return vec4(0.0);
  vec2 p = world + u_seedOffset;
  float level = sludgeLevel(zone);
  float patches = sludgePatches(p);
  if (patches < level - 0.09) return vec4(0.0);
  // Along the current: a direction per map, bent by a broad warp.
  float a = 6.2832 * fract(u_seedOffset.x * 0.0137 + u_seedOffset.y * 0.0071);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 bent = p + (vec2(fbm(p * 0.004 + 11.0), fbm(p * 0.004 + 29.0)) - 0.5) * 160.0;
  vec2 q = vec2(dot(bent, dir), dot(bent, vec2(-dir.y, dir.x)));
  float strands = fbm(vec2(q.x * 0.025, q.y * 0.28));      // long along the current, thin across
  float fibres = vnoise(vec2(q.x * 0.07, q.y * 1.1));      // finer combing
  float body = smoothstep(level - 0.08, level + 0.06, patches);
  float mat = body * 0.75 + (strands - 0.5) * 1.1 + (fibres - 0.5) * 0.3;
  if (mat < 0.32) return vec4(0.0);
  // Colour: regional, then strand by strand.
  float tone = fbm(p * 0.009 + 20.0);
  vec3 c = mix(vec3(0.17, 0.21, 0.08), vec3(0.28, 0.30, 0.11), smoothstep(0.3, 0.7, tone)); // dark green .. olive
  c = mix(c, vec3(0.27, 0.20, 0.10), smoothstep(0.55, 0.75, fbm(p * 0.014 + 70.0)) * 0.8); // rotting brown
  c = mix(c, vec3(0.37, 0.38, 0.15), smoothstep(0.62, 0.8, fbm(vec2(q.x * 0.012, q.y * 0.09) + 5.0)) * 0.7); // yellowish slime
  c *= 0.8 + 0.4 * strands;                         // strand crests lighter
  c *= 1.0 - 0.18 * smoothstep(0.6, 1.1, mat);      // thick mat darker
  c *= 0.92 + 0.16 * fibres;
  float alpha = smoothstep(0.32, 0.5, mat) * 0.6 + 0.4 * step(0.4, mat); // thin fringe lets the floor through
  return vec4(c, alpha);
}

// Floor details. Like the sludge they live in the cached background, so they
// cost nothing per frame (redrawn only when the map, the sun or their amounts
// change): each is a jittered grid of shapes, one per cell at most, found by
// checking the 3x3 cells around the pixel; whether a cell has one is decided
// per cell, so shapes are whole. Sized and coloured like the plants, scum and
// pads above them (crisp shapes a few px across, the marsh palette), they
// gather in drifts and beds, are lit from the sun's side and cast a small
// shadow away from it (u_light) onto the floor.

// Leaf litter: fallen leaves, pointed at both ends with a stalk, thickest near
// the banks the trees and shrubs drop them from and gathered in drifts,
// thinning into the deep water. Ochre, brown, olive-tan, a little rust and the
// grey-brown of old leaves; a darker midrib, the half facing the sun lighter
// (they lie a little curled).
const float LEAF_CELL = 8.0;
vec4 litter(vec2 world, float depth, float shore) {
  float zone = (1.0 - smoothstep(0.3, 0.8, depth)) * mix(0.35, 1.0, shore);
  if (u_litter <= 0.0 || zone <= 0.0) return vec4(0.0);
  vec2 seed = u_seedOffset + 311.0;
  ivec2 base = ivec2(floor(world / LEAF_CELL));
  vec4 col = vec4(0.0);
  float order = -1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      vec2 centre = (c + 0.1 + 0.8 * vec2(ihash(c + seed), ihash(c + seed + 71.0))) * LEAF_CELL;
      float drift = smoothstep(0.42, 0.62, fbm((centre + seed) * 0.009));
      if (ihash(c + seed + 5.0) >= u_litter * zone * (0.12 + 1.1 * drift)) continue;
      float a = ihash(c + seed + 11.0) * 6.2832;
      float ca = cos(a), sa = sin(a);
      vec2 q = mat2(ca, -sa, sa, ca) * (world - centre);
      float len = 2.6 + 2.0 * ihash(c + seed + 17.0); // half length
      float wid = len * (0.38 + 0.18 * ihash(c + seed + 23.0));
      float x = q.x / len;
      float half_ = wid * (1.0 - x * x);
      bool blade = abs(x) < 1.0 && abs(q.y) < half_;
      bool stalk = q.x >= len - 0.3 && q.x < len + 1.3 && abs(q.y) < 0.5;
      if (!blade && !stalk) continue;
      float top = ihash(c + seed + 41.0); // which overlapping leaf lies on top
      if (top < order) continue;
      order = top;
      float v = ihash(c + seed + 29.0);
      vec3 leaf = v < 0.3 ? vec3(0.47, 0.38, 0.22) : v < 0.55 ? vec3(0.38, 0.28, 0.16) : v < 0.75 ? vec3(0.42, 0.40, 0.24) : v < 0.88 ? vec3(0.50, 0.30, 0.15) : vec3(0.33, 0.31, 0.24);
      leaf *= 0.88 + 0.24 * ihash(c + seed + 37.0);
      if (blade) {
        leaf *= 1.0 + 0.14 * sign(q.y) * dot(vec2(-sa, ca), sunDir()); // curled: one half to the sun
        if (abs(q.y) < 0.45) leaf *= 0.78;                               // midrib
        else if (abs(q.y) > half_ - 0.6) leaf *= 0.88;                   // darker rim
      } else leaf *= 0.7;
      col = vec4(leaf, 1.0);
    }
  }
  return col;
}

// Pebbles: beds of rounded stones in the shallows, lit from the sun's side
// with a darker rim and a wet glint, greening with algae the deeper they lie.
const float PEBBLE_CELL = 6.0;
vec3 stoneColour(float v, float w, float depth) {
  vec3 c = mix(vec3(0.50, 0.48, 0.43), vec3(0.45, 0.39, 0.30), v);
  c = mix(c, vec3(0.33, 0.31, 0.28), step(0.8, w)); // a few dark ones
  return mix(c, vec3(0.26, 0.31, 0.17), smoothstep(0.12, 0.55, depth) * 0.7);
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
      float bed = smoothstep(0.42, 0.62, vnoise((centre + seed) * 0.018));
      if (ihash(c + seed + 47.0) >= u_stones * zone * bed * 1.3) continue;
      float r = 1.3 + 1.5 * ihash(c + seed + 53.0);
      float a = ihash(c + seed + 61.0) * 3.1416;
      float ca = cos(a), sa = sin(a);
      vec2 q = mat2(ca, -sa, sa, ca) * (world - centre);
      vec2 n2 = q / (r * vec2(1.0, 0.7 + 0.3 * ihash(c + seed + 67.0)));
      float rr = dot(n2, n2);
      if (rr >= 1.0) continue;
      n2 = transpose(mat2(ca, -sa, sa, ca)) * n2; // back to world directions
      vec3 n = vec3(n2, sqrt(1.0 - rr));
      float sun = max(dot(n, u_sun), 0.0);
      vec3 stone = stoneColour(ihash(c + seed + 59.0), ihash(c + seed + 73.0), depth);
      stone *= (0.55 + 0.6 * sun) * mix(1.0, 0.78, smoothstep(0.6, 1.0, rr));
      stone += vec3(0.08) * step(0.97, sun); // wet glint
      col = vec4(stone, 1.0);
    }
  }
  return col;
}

// Sunken twigs: waterlogged sticks with a slight bend, some with a side
// branch, more near the banks; bark-brown to grey, lighter along the side
// facing the sun.
const float TWIG_CELL = 30.0;
vec2 closest(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return a + ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
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
      vec2 perp = vec2(-dir.y, dir.x);
      float half_ = 6.0 + 7.0 * ihash(c + seed + 11.0);
      vec2 p0 = centre - dir * half_;
      vec2 p1 = centre + dir * half_;
      vec2 mid = centre + perp * (ihash(c + seed + 31.0) - 0.5) * 5.0; // the bend
      float w = 0.8 + 0.5 * ihash(c + seed + 13.0);
      vec2 near = closest(world, p0, mid);
      vec2 near1 = closest(world, mid, p1);
      if (distance(world, near1) < distance(world, near)) near = near1;
      if (ihash(c + seed + 17.0) < 0.6) {
        // A side branch from partway along, thinner.
        float t = 0.3 + 0.4 * ihash(c + seed + 19.0);
        float b = a + (ihash(c + seed + 23.0) < 0.5 ? 0.7 : -0.7);
        vec2 s0 = t < 0.5 ? mix(p0, mid, t * 2.0) : mix(mid, p1, t * 2.0 - 1.0);
        vec2 nb = closest(world, s0, s0 + vec2(cos(b), sin(b)) * half_ * 0.55);
        if (distance(world, nb) + 0.25 < distance(world, near)) near = nb;
      }
      vec2 off = world - near;
      float d = length(off);
      if (d >= w) continue;
      float v = ihash(c + seed + 29.0);
      vec3 wood = mix(vec3(0.27, 0.20, 0.13), vec3(0.36, 0.29, 0.19), v);
      wood = mix(wood, vec3(0.34, 0.32, 0.27), step(0.8, ihash(c + seed + 37.0))); // bleached
      if (d > w * 0.35) wood *= 1.0 + 0.2 * sign(dot(off, sunDir()));              // round, lit from one side
      return vec4(wood, 1.0);
    }
  }
  return vec4(0.0);
}

// The bare floor: a mucky film of silt and rot, mottled green-grey, grey and
// brown at two scales, with fine fibres and bits of stick in it. It thickens
// and darkens towards the sludge patches (the same patch noise, below their
// level), so a patch's edge fades into the floor around it instead of
// stopping dead. Returns the colour and how much it covers.
const float FIBRE_CELL = 6.0;
vec4 floorMuck(vec2 world, float depth) {
  vec2 seed = u_seedOffset + 997.0;
  vec2 p = world + u_seedOffset;
  float broad = fbm((world + seed) * 0.012);
  float fine = fbm((world + seed) * 0.08 + 4.0);
  vec3 muck = mix(vec3(0.25, 0.27, 0.19), vec3(0.27, 0.22, 0.14), smoothstep(0.35, 0.65, broad)); // green-grey .. brown
  muck = mix(muck, vec3(0.24, 0.24, 0.21), smoothstep(0.5, 0.75, fine) * 0.6);                    // grey silt
  muck *= 0.8 + 0.4 * fine;
  // Towards the sludge: thicker, darker olive.
  float zone = sludgeZone(depth);
  float halo = SLUDGE > 0.0 ? smoothstep(sludgeLevel(zone) - 0.14, sludgeLevel(zone) + 0.02, sludgePatches(p)) * zone : 0.0;
  muck = mix(muck, vec3(0.18, 0.20, 0.09), halo * 0.6);
  float cover = (0.45 + 0.3 * broad + 0.3 * halo) * (1.0 - mix(1.0, 0.5, u_waterTint) * smoothstep(0.55, 0.95, depth)); // thinner in the deep (gone in clear blue-green water)
  // Fibres and bits of stick: short dark strokes, one per cell at most.
  ivec2 base = ivec2(floor(world / FIBRE_CELL));
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2(base + ivec2(i, j));
      if (ihash(c + seed + 3.0) >= 0.4 + 0.35 * halo) continue;
      vec2 centre = (c + 0.1 + 0.8 * vec2(ihash(c + seed), ihash(c + seed + 71.0))) * FIBRE_CELL;
      float a = ihash(c + seed + 7.0) * 6.2832;
      vec2 dir = vec2(cos(a), sin(a));
      float half_ = 1.0 + 2.2 * ihash(c + seed + 11.0);
      if (distance(world, closest(world, centre - dir * half_, centre + dir * half_)) >= 0.75) continue;
      muck = mix(vec3(0.17, 0.13, 0.08), vec3(0.26, 0.21, 0.13), ihash(c + seed + 13.0));
      cover = max(cover, 0.85 * (1.0 - smoothstep(0.55, 0.95, depth)));
    }
  }
  return vec4(muck, cover);
}

// Heights (px) the details stand off the floor, for their shadows.
const float LEAF_H = 0.6;
const float STONE_H = 1.6;
const float TWIG_H = 1.2;

void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  float e = texture(u_elev, (world / u_elevCell + 0.5) / u_elevDims).r;
  float d = texture(u_sdf, world / u_sdfExtent).r; // + water, - land

  float depth = clamp((u_landLevel - e) / u_landLevel, 0.0, 1.0);
  // Murky swamp water: olive-brown shallows, then by u_waterTint from dark
  // peaty blue-green (0) to a muddy brown (1) in the middle and the deep.
  vec3 shallow = vec3(0.31, 0.32, 0.19);
  vec3 mid = mix(vec3(0.17, 0.21, 0.14), vec3(0.21, 0.21, 0.13), u_waterTint);
  vec3 deep = mix(vec3(0.06, 0.09, 0.08), vec3(0.17, 0.13, 0.08), u_waterTint);
  float look = depthLook(depth);
  vec3 water = look < 0.5
    ? mix(shallow, mid, smoothstep(0.0, 0.5, look))
    : mix(mid, deep, smoothstep(0.5, 1.0, look));

  // Soil: the tint of the plants growing there (their colour region, as the
  // plant bases are coloured) or a warm earth brown, in patches; never so
  // dark that the gaps between plants read as holes.
  float grain = hash(floor(world / 3.0));
  vec2 tint = texture(u_tint, (world / u_tintCell + 0.5) / u_tintDims).rg;
  vec3 region = mix(mix(vec3(0.19, 0.28, 0.11), vec3(0.29, 0.33, 0.13), tint.g), vec3(0.29, 0.23, 0.14), tint.r); // plant base palette
  vec3 earth = mix(vec3(0.34, 0.27, 0.18), vec3(0.29, 0.23, 0.15), fbm(world * 0.05 + 13.0));
  vec3 land = mix(region * 1.05, earth, smoothstep(0.4, 0.6, fbm(world * 0.018 + u_seedOffset)));
  land *= 0.9 + 0.14 * grain;
  // Beside a trunk the ground is bare and dry (plants make way for it, see
  // landClearing): a lighter brown of crumbled bark and turned earth, so the
  // shadows piling up there stay brown instead of turning black.
  float toTrunk = texelFetch(u_trunks, clamp(ivec2(world), ivec2(0), textureSize(u_trunks, 0) - 1), 0).g;
  vec3 dry = mix(vec3(0.40, 0.32, 0.21), vec3(0.34, 0.27, 0.18), fbm(world * 0.09 + 5.0));
  land = mix(land, dry, (1.0 - smoothstep(22.0, 40.0, toTrunk)) * 0.85); // as far as plants make way (a plant's reach)
  land = mix(land, vec3(0.16, 0.14, 0.10), smoothstep(-6.0, 0.0, d)); // wet mud: the last 6 px before the water

  // Things on the floor are seen through the whole water column: the murk a
  // fish on the bottom gets, and a little more the deeper they lie. The mucky
  // film, stones, then leaves and twigs on them, then sludge over everything.
  float murk = 1.0 - (1.0 - murkAt(depth)) * (1.0 - 0.5 * depth);
  float shore = 1.0 - smoothstep(0.0, 120.0, d);
  vec4 film = floorMuck(world, depth);
  water = mix(water, mix(film.rgb, water, murk), film.a);
  // Each casts a shadow onto what lies below it: shadowed where the shape
  // covers the point a little towards the sun (by its height).
  vec4 stone = stones(world, depth);
  if (stone.a == 0.0 && stones(world - u_light * STONE_H, depth).a > 0.0) water *= mix(0.72, 1.0, murk);
  water = mix(water, mix(stone.rgb, water, murk), stone.a);
  vec4 leaf = litter(world, depth, shore);
  if (leaf.a == 0.0 && litter(world - u_light * LEAF_H, depth, shore).a > 0.0) water *= mix(0.8, 1.0, murk);
  water = mix(water, mix(leaf.rgb, water, murk), leaf.a);
  vec4 twig = twigs(world, depth, shore);
  if (twig.a == 0.0 && twigs(world - u_light * TWIG_H, depth, shore).a > 0.0) water *= mix(0.75, 1.0, murk); // shadows fade into the murk with what casts them
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
uniform float u_amount;    // how much scum: 0 none, 1 as generated, 2 spreading far over the water
uniform sampler2D u_plantDensity; // 0..1 how crowded with plants, u_densityCell px cells
uniform float u_densityCell;
uniform float u_amongPlants; // scum among plants: 0 none, 1 as generated, 2 crowding into them
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
  if (u_amount <= 0.0) return;
  float base = (1.0 - depth) * 0.75 + shoreBoost * 0.25 - 0.62 + (u_amount - 1.0) * 0.22;
  float plants = texture(u_plantDensity, world / u_densityCell / vec2(textureSize(u_plantDensity, 0))).r;
  base += (u_amongPlants - 1.0) * plants * 0.6;
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
// Silt stirred up from the floor (SiltField; looks: SILT_LOOK). Drawn over
// the floor, under the fish (low fish inside a cloud are veiled in boidFS).
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
${SILT_LOOK}
void main() {
  vec2 world = v_uv * u_view + u_viewOffset;
  float d = texture(u_silt, world / u_siltExtent).r;
  if (d < 0.03) discard;
  vec4 water = texelFetch(u_background, ivec2(gl_FragCoord.xy), 0);
  if (water.a <= 0.0) discard; // land
  vec4 cloud = siltLook(d, water.rgb, water.a);
  o = vec4(cloud.rgb * cloud.a, cloud.a);
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

// Trunk colours, baked once per trunk layout (gpu/MapTextures.js) into a
// world-space texture, one texel per px: the colour of the highest trunk
// surface there (a = 1), before light and shade. Per trunk (its seed): a
// colour roll from dark brown through grey-tan and silver to pale, and some
// are birch-like, chalky white with dark dashes across the grain and dark
// patches. Along the grain: streaks, checks, remnant bark and moss. Close to
// the water (by how high that surface is above it): lichen crusts (pale
// grey-green, some yellow-orange) higher up, and slimy green algae at and
// below the waterline. Drawn per frame (logFS) with one texture read.
export const trunkLookFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
${NOISE}
${LOGS}
out vec4 o;
vec3 trunkColour(int i, vec4 sec) {
  vec4 look = logLook(i);
  float seed = look.x;
  float s = sec.y;
  float along = sec.x * look.y + look.w; // distance along the whole trunk
  float roll = hash(vec2(seed * 91.7, 3.1));
  bool birch = hash(vec2(seed * 53.3, 7.7)) < 0.28;
  vec3 base = roll < 0.3 ? mix(vec3(0.40, 0.30, 0.20), vec3(0.50, 0.40, 0.29), roll / 0.3)            // browner
    : roll < 0.7 ? mix(vec3(0.56, 0.51, 0.43), vec3(0.66, 0.64, 0.58), (roll - 0.3) / 0.4)              // grey-tan .. silver
    : mix(vec3(0.70, 0.67, 0.60), vec3(0.78, 0.75, 0.68), (roll - 0.7) / 0.3);                          // pale
  if (birch) base = mix(vec3(0.84, 0.82, 0.76), vec3(0.78, 0.76, 0.70), roll);
  vec3 wood = base * (0.86 + 0.24 * vnoise(vec2(along * 0.05, s * 6.0 + seed * 9.0))); // long grain streaks
  float check = abs(vnoise(vec2(along * 0.08, s * 9.0 + seed * 5.0)) - 0.5);
  wood *= 1.0 - (birch ? 0.15 : 0.38) * step(check, 0.035);                               // checks along the grain
  if (birch) {
    // Dark dashes across the grain (short along it), and dark patches.
    float dash = vnoise(vec2(along * 0.8, s * 1.3 + seed * 13.0));
    wood = mix(wood, vec3(0.20, 0.19, 0.17), step(0.68, dash) * 0.9);
    float patch_ = fbm(vec2(along * 0.07, s * 0.9) + seed * 31.0);
    wood = mix(wood, vec3(0.16, 0.15, 0.14), smoothstep(0.66, 0.7, patch_) * 0.85);
    wood = mix(wood, vec3(0.80, 0.66, 0.52), smoothstep(0.7, 0.74, fbm(vec2(along * 0.05, s) + seed * 17.0)) * 0.5); // peeling, warmer
  } else {
    float bark = smoothstep(0.6, 0.7, fbm(vec2(along * 0.04, s * 1.2) + seed * 23.0));
    wood = mix(wood, base * 0.48, bark * 0.85);                                           // remnant bark
  }
  // Close to the water: how high this surface is above it (px; < 0 under).
  float above = (logTop(sec) - LOG_LAND) / LOG_ELEV_PER_PX;
  float damp = 1.0 - smoothstep(2.0, 24.0, above);
  float moss = smoothstep(0.58, 0.75, fbm(vec2(along * 0.03, s) + seed * 41.0)) * (1.0 - abs(s));
  wood = mix(wood, vec3(0.34, 0.42, 0.18), moss * mix(0.45, 0.85, damp));
  // Lichen: crusty spots, mostly on the upper side, where it is damp but dry enough.
  float lichenZone = (0.45 + 0.55 * (1.0 - smoothstep(4.0, 40.0, above))) * smoothstep(-1.0, 1.5, above) * (1.0 - 0.5 * s * s);
  // Small crusts (a few px), in colonies that are thicker where it is damper.
  float spot = vnoise(vec2(along * 0.7, s * 7.0) + seed * 7.0);
  float colony = smoothstep(0.35, 0.6, fbm(vec2(along * 0.05, s * 0.7) + seed * 29.0));
  float kind = vnoise(vec2(along * 0.09, s * 1.2) + seed * 19.0);
  vec3 lichen = kind > 0.72 ? vec3(0.74, 0.56, 0.22) : kind < 0.3 ? vec3(0.44, 0.52, 0.36) : vec3(0.58, 0.64, 0.46);
  float crust = step(0.76 - 0.14 * lichenZone, spot) * colony * step(0.05, lichenZone);
  wood = mix(wood, lichen * (0.9 + 0.2 * hash(floor(vec2(along, s * 8.0)))), crust * 0.85);
  // Algae: slimy green at the waterline and below, in patches, darker lower down.
  float wet = 1.0 - smoothstep(0.0, 6.0, above);
  float slime = smoothstep(0.4, 0.55, fbm(vec2(along * 0.06, s * 1.5) + seed * 61.0) + wet * 0.25);
  vec3 algae = mix(vec3(0.26, 0.36, 0.13), vec3(0.17, 0.25, 0.10), smoothstep(0.0, -6.0, above));
  wood = mix(wood, algae, wet * slime * 0.9);
  return wood;
}
// Shelf fungi (brackets): on about 60% of the trunks, on dry stretches (4+ px
// above the water), now and then a cluster of 1-3 half-discs grows out from a
// side, overlapping, each cluster one colour (orange, white, tan or brown)
// with growth rings, darker at the base and a pale fresh rim. In the bake's
// alpha 0.5 (wood is 1): logFS draws them past the trunk's outline too.
const float BRACKET_STRETCH = 16.0; // px of trunk per possible cluster
vec4 bracketAt(int i, vec4 sec) {
  vec4 look = logLook(i);
  float seed = look.x;
  if (sec.x < 0.0 || sec.x > 1.0 || hash(vec2(seed * 37.1, 2.9)) < 0.4) return vec4(0.0);
  float above = (sec.z - LOG_LAND) / LOG_ELEV_PER_PX; // axis height above the water (px)
  if (above < 4.0) return vec4(0.0);
  float r = sec.w / LOG_ELEV_PER_PX;
  float along = sec.x * look.y + look.w;
  float side = sec.y < 0.0 ? -1.0 : 1.0;
  float out_ = abs(sec.y) * r - r; // px beyond the side
  if (out_ > 6.0 || out_ < -1.0) return vec4(0.0);
  float cell = floor(along / BRACKET_STRETCH);
  vec4 found = vec4(0.0);
  for (int k = -1; k <= 1; k++) {
    float c = cell + float(k);
    vec2 h = vec2(seed * 113.0 + c * 1.7, side * 3.3 + seed * 7.0);
    if (hash(h) > 0.25 + 0.15 * smoothstep(4.0, 25.0, above)) continue; // now and then: drier, a little more often
    float pick = hash(h + 5.1);
    vec3 col = pick < 0.3 ? vec3(0.86, 0.50, 0.18) : pick < 0.55 ? vec3(0.88, 0.85, 0.77) : pick < 0.8 ? vec3(0.72, 0.60, 0.42) : vec3(0.46, 0.31, 0.18);
    float n = 1.0 + floor(hash(h + 9.7) * 3.0);
    for (int m = 0; m < 3; m++) {
      if (float(m) >= n) break;
      float R = 3.0 + 3.0 * hash(h + float(m) * 2.3 + 1.1);
      float u = along - (c + 0.2 + 0.6 * hash(h + float(m) * 4.1 + 0.7)) * BRACKET_STRETCH;
      float v = out_ + 1.0; // rooted a little inside the outline
      if (v < 0.0) continue;
      float e = (u * u) / (R * R * 1.2) + (v * v) / (R * R * 0.75); // wider along the trunk than out
      if (e >= 1.0) continue;
      float d = sqrt(e);
      vec3 cc = col * (0.9 + 0.12 * step(0.5, fract(d * (1.5 + R * 0.35))));  // growth rings
      cc *= mix(0.7, 1.0, smoothstep(0.0, 0.5, d));                           // darker at the base
      cc = mix(cc, vec3(0.93, 0.89, 0.80), smoothstep(0.78, 0.95, d) * 0.45); // pale fresh rim
      found = vec4(cc, 0.5);
    }
  }
  return found;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  // Brackets first: they sit on the trunk's edge and out past it.
  for (int i = 0; i < u_logCount; i++) {
    vec4 e = logEnds(i);
    vec4 sz = logSize(i);
    float r = max(sz.x, sz.y) + 8.0;
    if (p.x < min(e.x, e.z) - r || p.x > max(e.x, e.z) + r || p.y < min(e.y, e.w) - r || p.y > max(e.y, e.w) + r) continue;
    vec4 b = bracketAt(i, logSection(i, p));
    if (b.a > 0.0) { o = b; return; }
  }
  float top = -1.0;
  int best = -1;
  vec4 bestSec = vec4(0.0);
  for (int i = 0; i < u_logCount; i++) {
    vec4 e = logEnds(i);
    vec4 sz = logSize(i);
    float r = max(sz.x, sz.y) + 1.0;
    if (p.x < min(e.x, e.z) - r || p.x > max(e.x, e.z) + r || p.y < min(e.y, e.w) - r || p.y > max(e.y, e.w) + r) continue;
    vec4 sec = logSection(i, p);
    if (abs(sec.y) > 1.0 || !logCovers(i, vec4(sec.x, 0.0, sec.zw))) continue;
    float t = logTop(sec);
    if (t > top) { top = t; best = i; bestSec = sec; }
  }
  if (best < 0) { o = vec4(0.0); return; }
  o = vec4(trunkColour(best, bestSec), 1.0);
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
  float rMax = max(sz.x, sz.y) + 8.0; // room for round joints and shelf fungi
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
uniform sampler2D u_trunkLook;  // baked trunk colours (trunkLookFS)
out vec4 o;
${MASK}
${NOISE}
${LOGS}
void main() {
  vec4 sec = logSection(v_seg, v_world);
  // Shelf fungi stick out past the outline (baked: alpha 0.5, see trunkLookFS).
  vec4 baked = texelFetch(u_trunkLook, clamp(ivec2(v_world), ivec2(0), textureSize(u_trunkLook, 0) - 1), 0);
  bool fungus = baked.a > 0.25 && baked.a < 0.75;
  if (fungus && u_pass == 1 && abs(sec.y) >= 0.9) {
    // Past (or at) the edge: a flat shelf, lit from above.
    o = vec4(baked.rgb * (0.7 + 0.45 * max(u_sun.z, 0.0)) * shadeTrunk(false), 1.0);
    return;
  }
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

  // Its colour, baked (trunkLookFS); the texel's own trunk where two cross.
  vec3 wood = baked.rgb;
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
    float murk = murkAt(sqrt(clamp(below * LOG_MURK, 0.0, 1.0)));
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
uniform sampler2D u_flowerLook; // 2 texels per plant: its head colours, fresh and withered (gpu/PondGpu.js)
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
uniform vec4 u_windPair; // gusts roll along two fixed directions, cross-faded (see CLOUDS)
uniform float u_windMix;
out vec3 v_color;
out float v_t;
const float TAU = 6.28318530718;

const vec2 Q[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(1, 1), vec2(0, -1), vec2(1, 1), vec2(0, 1));

// Regional palettes seen from above in marshes (muted for the lo-fi look):
// live olive-green stands, yellow-green fresh growth / sedge, dry tan-brown reed.
// (The tips are mirrored in sim/Vegetation.js, for the withered flower colours.)
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
  // (Along fixed directions, cross-faded: a turning wind never sweeps them.)
  float gust = 0.5 + 0.5 * mix(sin(u_time * 1.3 - dot(base, u_windPair.xy) * 0.012 + seed * 1.5),
    sin(u_time * 1.3 - dot(base, u_windPair.zw) * 0.012 + seed * 1.5), u_windMix);
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
    // A flower drunk down by the midges fades towards a withered, leafy bud
    // (each plant's own colours, baked: Vegetation headColours).
    int plant = u_start + local;
    int bw = textureSize(u_bloom, 0).x;
    float bloom = texelFetch(u_bloom, ivec2(plant % bw, plant / bw), 0).r;
    int lw = textureSize(u_flowerLook, 0).x;
    vec3 fresh = texelFetch(u_flowerLook, ivec2(plant * 2 % lw, plant * 2 / lw), 0).rgb;
    vec3 withered = texelFetch(u_flowerLook, ivec2((plant * 2 + 1) % lw, (plant * 2 + 1) / lw), 0).rgb;
    v_color = mix(withered, fresh, smoothstep(0.0, 1.0, bloom)) * (0.9 + 0.2 * q.x);
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

// Midges (species/midges.js; midgeVS feeds this from their GPU textures): one point each, in
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
  if (u_mode == 0 || u_mode == 3) size = state == 1 ? 8.0 : state == 4 ? 2.0 : state == 5 ? 4.0 : state == 7 ? 16.0 : state == 9 ? 8.0 : 0.0;
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

// Lines in scene pixels from a CPU buffer (render/focus.js overlays): lines
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
const float RIPPLE_LIFE = ${RIPPLE_LIFE.toFixed(2)}; // s
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
layout(location = 1) in vec4 a_look; // seed, flower (LilyPads FLOWER), variety (VARIETY), -
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
out vec3 v_look;
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
  v_look = a_look.xyz;
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
in vec3 v_look; // seed, flower (0 none, 1 open, 2 bud), variety (0 pink, 1 white, 2 yellow)
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

  // The colony's variety: petal colour at the base and at the tip.
  int variety = int(v_look.z + 0.5);
  vec3 petalBase = variety == 0 ? vec3(0.84, 0.52, 0.62) : variety == 1 ? vec3(0.90, 0.88, 0.80) : vec3(0.90, 0.76, 0.28);
  vec3 petalTip = variety == 0 ? vec3(0.95, 0.80, 0.84) : variety == 1 ? vec3(0.97, 0.96, 0.92) : vec3(0.97, 0.90, 0.50);
  int flower = int(v_look.y + 0.5);
  if (flower == 1) {
    // Open bloom: an outer ring of pointed petals and an inner one between
    // them, a little darker towards the base; a golden centre.
    float size = 0.5 + 0.15 * fract(seed * 7.3);
    float outer = size * (0.55 + 0.45 * pow(abs(cos(a * 4.0 + seed * 3.0)), 0.6));
    float inner = size * 0.68 * (0.55 + 0.45 * pow(abs(cos(a * 4.0 + seed * 3.0 + 0.785)), 0.6));
    if (d < outer) col = mix(petalBase, petalTip, d / outer) * 0.92;
    if (d < inner) col = mix(petalBase, petalTip, d / inner);
    if (d < size * 0.24) col = vec3(0.88, 0.70, 0.26) * (0.9 + 0.2 * step(0.5, fract(a * 2.0 + d * 20.0)));
  } else if (flower == 2) {
    // Closed bud: a small pointed oval off-centre, green at the base turning
    // to the bloom's colour at its tip.
    float ba = seed * 6.2832;
    vec2 q = mat2(cos(ba), -sin(ba), sin(ba), cos(ba)) * (v_local - vec2(0.15, -0.1));
    float x = q.x / 0.36;
    if (abs(x) < 1.0 && abs(q.y) < 0.16 * (1.0 - x * x)) {
      col = mix(vec3(0.30, 0.45, 0.22), petalTip, smoothstep(-0.2, 0.9, x));
      if (q.y > 0.02) col *= 0.85; // the shaded side
    }
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
// For the fixed direction wd (see windA / windB).
float ripplePhase(vec2 world, float time, vec2 wd) {
  float bend = cloud(world / 140.0 - u_windTravel * 0.004) + cloud(world / 45.0 + 0.3) * 0.35;
  return dot(world, wd) * TAU / RIPPLE_WAVELENGTH - time * RIPPLE_SPEED + bend * 18.0;
}
// sin of the phase, both directions cross-faded: 1 on a crest.
float rippleWave(vec2 world, float time) {
  return mix(sin(ripplePhase(world, time, windA())), sin(ripplePhase(world, time, windB())), u_windMix) * windMixNorm();
}
// Its slope (cos of the phase), cross-faded alike.
float rippleSlope(vec2 world, float time) {
  return mix(cos(ripplePhase(world, time, windA())), cos(ripplePhase(world, time, windB())), u_windMix) * windMixNorm();
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
  vec2 p = world / SWIRL_SCALE - u_windTravel * SWIRL_SPEED * 0.5;
  vec2 w1 = vec2(cloud(p * 0.7 + vec2(t, 0.31)), cloud(p * 0.7 + vec2(0.63, -t))) - 0.5;
  vec2 q = p + w1 * 0.6;
  vec2 w2 = vec2(cloud(q * 1.3 + 0.2 - t * 0.7), cloud(q * 1.3 + 0.8 + t * 0.7)) - 0.5;
  return cloud(q * 2.0 + w2 * 0.8) - 0.5; // about -0.3 .. 0.3
}

// 0, 1 or 2: brightness band of the caustic web here.
float caustics(vec2 world) {
  vec2 p = world / CAUSTIC_SCALE;
  float t = u_time * CAUSTIC_SPEED;
  // One layer whose ridges (noise = 0.5) are the bright lines, drifting
  // downwind with the ripples that focus them, wobbled by a second, slower
  // layer so the web shimmers instead of only sliding.
  vec2 wobble = vec2(cloud(p * 0.8 + vec2(-0.6, 0.8) * t + 0.5), cloud(p * 0.8 + vec2(0.7, 0.5) * t + 0.2)) - 0.5;
  float a = cloud(p - u_causticShift + wobble * 0.12);
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
    float slope = rippleSlope(world, u_time) * shallow * u_windStrength;
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

// Noise stretched along the crests (direction wd), breaking them into dashes.
float rippleDash(vec2 world, vec2 wd) {
  return cloud(vec2(dot(world, wd) / 40.0, dot(world, vec2(-wd.y, wd.x)) / 90.0) - vec2(u_time * 0.02, 0.0));
}

// Shallow ripples: sparse glints on the crests, livelier in fish wakes.
float shallowRipples(vec2 world, float depth) {
  float shallow = 1.0 - smoothstep(0.1, 0.4, depth);
  if (shallow <= 0.0) return 0.0;
  float wake = clamp(length(texture(u_sway, world / u_swayExtent).xy) * 0.6, 0.0, 1.0);
  float crest = rippleWave(world, u_time);
  if (crest < 0.86 - 0.12 * wake) return 0.0;
  float dash = mix(rippleDash(world, windA()), rippleDash(world, windB()), u_windMix);
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
uniform vec3 u_sunlight;   // light on the scene: brightness and tint from the sun's height
out vec4 o;
${CLOUDS}
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(u_scene, t, 0).rgb * u_sunlight;
  // Scene row 0 is the bottom of the screen; world y grows downwards.
  vec2 world = u_viewOffset + (vec2(t.x, u_low.y - 1 - t.y) + 0.5) * u_cell;
  float b = mix(0.5, BAYER[(t.x & 3) + (t.y & 3) * 4] / 16.0, DITHER);
  c = floor(c * u_levels + b) / u_levels;
  // Cloud shade after the colour levels, itself in dithered steps: shading
  // the levels would squeeze dark gradients (deep to mid water) into one or
  // two levels with hard contours; this way the shade stays pixelated but
  // the shadowed scene keeps the bands it has in the sun.
  if (u_cloudsOn) {
    float shade = mix(1.0, CLOUD_SHADE, cloudCover(world));
    c *= floor(shade * u_levels + b) / u_levels;
  }

  vec2 q = gl_FragCoord.xy / vec2(u_low) - 0.5;
  c *= 1.0 - VIGNETTE * dot(q, q);
  o = vec4(c, 1.0);
}
`


// Midges drawn straight from their GPU species textures (gpu/boids/BoidKernel.js,
// species/midges.js): insectVS with its point attributes read by vertex id
// (state: x, y; aux: height in w, point state in y, an egg's ripeness in z;
// traits: seed), the selected one flagged.
const MIDGE_FETCH = /* glsl */ `
uniform highp sampler2D u_mState;
uniform highp sampler2D u_mAux;
uniform highp sampler2D u_mTraits;
uniform int u_mTexW;
uniform int u_mTexShift;
uniform int u_mCount;
uniform int u_mSelected;
ivec2 midgeTexel(int i) { return ivec2(i & (u_mTexW - 1), i >> u_mTexShift); }`
export const midgeVS = insectVS
  .replace(
    `layout(location = 0) in vec4 a_body; // x, y, height above the water (px), state
layout(location = 1) in vec4 a_look; // seed, ripple age (s), egg maturity (0..1), selected (midges) / brood (rafts)`,
    `${MIDGE_FETCH}
uniform highp sampler2D u_mAux1;
uniform float u_time;     // sim time (s)
uniform float u_bodyTime; // params.insectBodyTime
const float RIPPLE_LIFE = ${RIPPLE_LIFE.toFixed(2)};
vec4 a_body; // x, y, height above the water (px), state
vec4 a_look; // seed, ripple age (mode 3), egg ripeness, selected`,
  )
  .replace(
    'void main() {\n  int state = int(a_body.w);',
    `void main() {
  ivec2 mc = midgeTexel(gl_VertexID);
  vec4 ms = texelFetch(u_mState, mc, 0);
  vec4 ma = texelFetch(u_mAux, mc, 0);
  a_body = vec4(ms.xy, ma.w, gl_VertexID < u_mCount ? ma.y : 6.0);
  a_look = vec4(texelFetch(u_mTraits, mc, 0).x, 0.0, ma.y == 5.0 ? ma.z : 0.0, gl_VertexID == u_mSelected ? 1.0 : 0.0); // an egg's ripeness in aux.z
  if (u_mode == 3) {
    // Ripples (drawn as state 7): a ring spreading where it laid an egg
    // (aux1: when, where), or where its body fell (dead: its body timer
    // counts down from its own body time, species/midges.js), on water only.
    vec4 m1 = texelFetch(u_mAux1, mc, 0);
    float age = m1.x >= 0.0 ? u_time - m1.x : 1e9;
    vec2 at = m1.yz;
    if (ma.y == 4.0) {
      float landed = u_bodyTime * (0.7 + 0.6 * fract(a_look.x * 91.7)) - ma.z;
      if (landed < age) { age = landed; at = ms.xy; }
    }
    float floorE = texture(u_elev, (at / u_elevCell + 0.5) / u_elevDims).r;
    bool on = gl_VertexID < u_mCount && age >= 0.0 && age < RIPPLE_LIFE && floorE < LAND;
    a_body = vec4(at, 0.0, on ? 7.0 : 6.0);
    a_look.y = age;
  }
  int state = int(a_body.w);`,
  )

// Midge motion trails: per flying midge a line from where it was at the
// frame's start (u_mPrev) to where it is, fading towards the tail; a hop
// longer than u_maxHop is not drawn.
export const midgeTrailVS = /* glsl */ `#version 300 es
precision highp float;
${MIDGE_FETCH}
uniform highp sampler2D u_mPrev;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;
uniform float u_maxHop;
uniform vec3 u_colour;
uniform float u_alpha;
out vec4 v_colour;
void main() {
  int i = gl_VertexID / 2;
  int end = gl_VertexID - i * 2;
  ivec2 mc = midgeTexel(i);
  vec2 p1 = texelFetch(u_mState, mc, 0).xy;
  vec2 p0 = texelFetch(u_mPrev, mc, 0).xy;
  float hop = distance(p0, p1);
  if (i >= u_mCount || texelFetch(u_mAux, mc, 0).y != 0.0 || hop < 1.0 || hop > u_maxHop) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_colour = vec4(0.0);
    return;
  }
  vec2 p = end == 0 ? p0 : p1;
  float a = end == 0 ? 0.0 : u_alpha;
  vec2 uv = ((p - u_viewOffset) / u_cell + 0.5) / (u_view / u_cell);
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  v_colour = vec4(u_colour * a, a);
}
`

// What the selected boid of a GPU species sees: a faint line to each of its
// kind in flight within its range (u_rangeTex red channel, per boid).
export const seenBoidsVS = /* glsl */ `#version 300 es
precision highp float;
${MIDGE_FETCH}
uniform highp sampler2D u_rangeTex;
uniform int u_rangeStride;
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;
uniform vec4 u_colour; // rgb, alpha
out vec4 v_colour;
void main() {
  int i = gl_VertexID / 2;
  ivec2 sc = midgeTexel(u_mSelected);
  vec2 me = texelFetch(u_mState, sc, 0).xy;
  float range = texelFetch(u_rangeTex, ivec2(sc.x * u_rangeStride, sc.y), 0).r;
  ivec2 mc = midgeTexel(i);
  vec2 p = texelFetch(u_mState, mc, 0).xy;
  if (i >= u_mCount || i == u_mSelected || texelFetch(u_mAux, mc, 0).y != 0.0 || distance(me, p) > range) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_colour = vec4(0.0);
    return;
  }
  vec2 q = gl_VertexID % 2 == 0 ? me : p;
  vec2 uv = ((q - u_viewOffset) / u_cell + 0.5) / (u_view / u_cell);
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  v_colour = vec4(u_colour.rgb * u_colour.a, u_colour.a);
}
`

// What the selected boid sees of the item sources (gpu/boids/ItemSources.js):
// a small ring round each item within its range, styled per source; flowers
// (sources 0 and 1) in their colour as drawn (as the midge sees it: nectar
// from withered to fresh). 12 segments, 24 vertices per item.
export const seenItemsVS = /* glsl */ `#version 300 es
precision highp float;
${MIDGE_FETCH}
uniform highp sampler2D u_rangeTex;
uniform int u_rangeStride;
uniform highp sampler2D u_items;
uniform highp sampler2D u_nectar;
uniform highp sampler2D u_flowerLook;
uniform int u_itemsW;
uniform int u_itemCount;
uniform vec4 u_srcColour[4]; // rgb, alpha (0: not shown)
uniform float u_srcRadius[4];
uniform vec2 u_view;
uniform vec2 u_viewOffset;
uniform vec2 u_cell;
out vec4 v_colour;
void main() {
  int k = gl_VertexID / 24;
  int v = gl_VertexID - k * 24;
  int seg = v / 2 + (v % 2);
  vec4 it = texelFetch(u_items, ivec2(k % u_itemsW, k / u_itemsW), 0);
  int src = int(it.w);
  ivec2 sc = midgeTexel(u_mSelected);
  vec2 me = texelFetch(u_mState, sc, 0).xy;
  float range = texelFetch(u_rangeTex, ivec2(sc.x * u_rangeStride, sc.y), 0).r;
  bool shown = k < u_itemCount && u_srcColour[src].a > 0.0 && distance(me, it.xy) <= range;
  if (!shown) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_colour = vec4(0.0);
    return;
  }
  float t = float(seg) / 12.0 * 6.2832;
  vec2 q = it.xy + vec2(cos(t), sin(t)) * u_srcRadius[src];
  vec2 uv = ((q - u_viewOffset) / u_cell + 0.5) / (u_view / u_cell);
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  vec4 c = u_srcColour[src];
  if (src < 2) {
    int i = int(it.z);
    int w = textureSize(u_nectar, 0).x;
    int lw = textureSize(u_flowerLook, 0).x;
    float nectar = texelFetch(u_nectar, ivec2(i % w, i / w), 0).r;
    vec3 fresh = texelFetch(u_flowerLook, ivec2(i * 2 % lw, i * 2 / lw), 0).rgb;
    vec3 withered = texelFetch(u_flowerLook, ivec2((i * 2 + 1) % lw, (i * 2 + 1) / lw), 0).rgb;
    c.rgb = mix(withered, fresh, smoothstep(0.0, 1.0, nectar));
  }
  v_colour = vec4(c.rgb * c.a, c.a);
}
`
