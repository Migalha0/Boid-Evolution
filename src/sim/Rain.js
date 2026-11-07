/** Seconds the rain takes to set in or clear (63% of the way), and to move between showers and lulls. */
const SET_EASE = 3
const CHANGE_EASE = 8
/** The cloud cover rain brings at full strength, and how far it darkens the clouds (towards RAIN_DARK). */
const RAIN_COVER = 0.85
const RAIN_DARK = 0.9
const RAIN_DARKEN = 0.35

/**
 * The rain as it falls now: `level` 0 dry .. 1 downpour, and whether it is
 * raining (`on`). By hand (params rainAuto off) it rains while `rain` is on.
 * Auto: dry spells and showers take turns, a shower lasting about
 * `rainSpell` s and a dry spell as long as makes it rain `rainFrequency` of
 * the time (each varied). Raining, every `rainChangeEvery` s or so (varied)
 * it settles on a new strength around `rainStrength` (by up to ±
 * `rainVariability`) and eases there; stopping, it eases away. It never jumps.
 */
export class Rain {
  constructor() {
    this.level = 0
    this.goal = 0
    this.clock = 0
    this.on = false
    this.spell = null // auto: s left of this dry spell or shower
  }

  /** Auto: whether it rains now, turning spells over as they run out. */
  weather(dt, p) {
    const f = p.rainFrequency
    if (f <= 0 || f >= 1) {
      this.spell = null
      return f >= 1
    }
    if (p.rainFrequency !== this.setFrequency || p.rainSpell !== this.setSpell) {
      // Set anew: the spell under way is drawn again for the new settings.
      this.setFrequency = p.rainFrequency
      this.setSpell = p.rainSpell
      this.spell = null
    }
    if (this.spell == null) {
      // Starting out (or taking over from the toggle): partway through a spell as it is now.
      this.spell = Math.random() * p.rainSpell * (this.on ? 1 : (1 - f) / f)
    }
    this.spell -= dt
    if (this.spell > 0) return this.on
    const on = !this.on
    this.spell = p.rainSpell * (on ? 1 : (1 - f) / f) * (0.5 + Math.random())
    return on
  }

  update(dt, p) {
    this.on = p.rainAuto ? this.weather(dt, p) : !!p.rain
    if (!p.rainAuto) this.spell = null
    if (!this.on) {
      this.goal = 0
      this.clock = 0
    } else {
      this.clock -= dt
      if (this.clock <= 0 || p.rainStrength !== this.setStrength || p.rainVariability !== this.setVariability) {
        this.setStrength = p.rainStrength
        this.setVariability = p.rainVariability
        this.clock = p.rainChangeEvery * (0.5 + Math.random())
        this.goal = Math.min(1, Math.max(0.05, p.rainStrength * (1 + (Math.random() * 2 - 1) * p.rainVariability)))
      }
    }
    // Setting in or clearing is quicker than a change of strength.
    const ease = this.goal === 0 || this.level < 0.05 ? SET_EASE : CHANGE_EASE
    this.level += (this.goal - this.level) * (1 - Math.exp(-dt / ease))
    if (this.level < 1e-3 && !this.goal) this.level = 0
  }
}

/**
 * The clouds' shader parameters, thicker and darker in the rain (level):
 * [noise tiles per world px, density where cloud starts, edge width, light
 * let through under a core] (render/shaders.js CLOUD_SCALE .. CLOUD_SHADE).
 */
export function cloudTune(p, level = 0) {
  const cover = p.cloudCover + (RAIN_COVER - p.cloudCover) * level
  const dark = p.cloudDarkness + Math.max(0, RAIN_DARK - p.cloudDarkness) * RAIN_DARKEN * level
  return [1 / p.cloudSize, 0.65 - 0.4 * cover, p.cloudSoftness, 1 - dark]
}

/** Rain drops: cell size and ring sizes in scene px, the ring's life (s) at the smallest size, as a midge's ripple. */
const RAIN_CELL = 26
const RAIN_MIN = 7
const RAIN_MAX = 21
const RAIN_LIFE = 0.9

/**
 * The rain drops, one field shared by the water (render/shaders.js draws a
 * ring where each lands) and the midges (species/midges.js: one flying under
 * a drop is hit), so every drop seen is one that can kill. Drops sit on a
 * grid anchored to the world, in scene px (world / cell px), two layers offset
 * by half a cell; each cell drops one now and then (its own period, idle in
 * between), each at its own spot and size, from an integer hash, so every
 * shader gets exactly the same drops. A drop falls only where the rain is
 * heavy enough for it (its own threshold under the level), and (checked by
 * the caller, only for the drops it needs) only under a cloud.
 */
export const RAIN_GLSL = /* glsl */ `
const float RAIN_CELL = ${RAIN_CELL.toFixed(1)};
const float RAIN_MIN = ${RAIN_MIN.toFixed(1)};
const float RAIN_MAX = ${RAIN_MAX.toFixed(1)};
const float RAIN_LIFE = ${RAIN_LIFE.toFixed(2)}; // s for the smallest ring
const float RAIN_CLOUD = 0.5; // cloud cover a drop needs where it lands
const vec2 RAIN_SHIFT = vec2(0.5, 0.37); // the second layer's offset (cells)
uint rainPcg(uint v) {
  uint st = v * 747796405u + 2891336453u;
  uint word = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
  return (word >> 22u) ^ word;
}
float rainUnit(uint h) { return float(h >> 8u) / 16777216.0; }
// The cell (scene px) of layer 0 or 1 that q is in.
ivec2 rainCellOf(vec2 q, int layer) { return ivec2(floor(q / RAIN_CELL + float(layer) * RAIN_SHIFT)); }
// The drop of cell c (layer 0 or 1) at time t (s), in rain of this level:
// false if it has none this period, else where it lands (scene px), how long
// ago (s; its ring spreads from then) and its largest ring (scene px). Also
// false if it landed maxAge s ago or more (the caller has no use for it):
// checked first, so most cells cost one hash.
bool rainDrop(ivec2 c, int layer, float t, float level, float maxAge, out vec2 at, out float age, out float R) {
  uint h0 = rainPcg(uint(c.x) * 1597334677u ^ rainPcg(uint(c.y) * 3812015801u ^ uint(layer)));
  float h = rainUnit(h0);
  // Long enough for the largest ring, plus an idle gap.
  float period = RAIN_LIFE * RAIN_MAX / RAIN_MIN * (1.2 + 1.5 * h);
  float tt = t + h * 97.0;
  float k = floor(tt / period);
  age = tt - k * period;
  if (age >= maxAge) return false;
  uint hk = rainPcg(h0 ^ uint(int(k)) * 2654435761u);
  if (rainUnit(hk) >= level) return false;
  float size = rainUnit(rainPcg(hk + 1u));
  R = mix(RAIN_MIN, RAIN_MAX, size * size); // more small drops than big
  at = (vec2(c) + vec2(rainUnit(rainPcg(hk + 2u)), rainUnit(rainPcg(hk + 3u))) - float(layer) * RAIN_SHIFT) * RAIN_CELL;
  return true;
}
`
