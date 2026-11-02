import { HEADER, ID_BITS, MAX_CELLS } from '../simShaders.js'

/**
 * Builds a species' update shader (the step that moves every boid) from its
 * definition (src/species/*.js), so all species share one frame:
 *
 *   inputs     the sorted state, the cell table, aux (and aux1 with
 *              def.auxTextures 2) and traits, the genes (G_<KEY> reads one:
 *              4 per texel, a boid's texels side by side), item sources
 *   pre        species GLSL: RANGE (how far it sees) and its own declarations
 *   flock      its own kind, nearest grid cells first, at most u_maxNeighbors
 *              counted and u_scanBudget looked at; for each candidate
 *              nb = (x, y, vx, vy) the species' `visit` GLSL runs (it bumps
 *              FLOCK_N for one it counts)
 *   items      every item sense in one pass over the item grid, nearest
 *              cells first and bounded: per sense <key> P_<key> (a pull
 *              towards its items within RANGE, each weighing 1 - d / RANGE,
 *              times its `weight` (GLSL on `id`, 1 without), at most 1
 *              long), N_<key> (how many), NEAR_<key> (the nearest seen: x,
 *              y, id, distance); items its `filter` rejects (GLSL on `id`)
 *              or weighs at 0 or less are not seen. A sense reads one item
 *              `source`, or several (`sources`)
 *   look       the flock and items are what it senses. Its tick rate
 *              (params[def.tickParam], in steps) says how often: above 1
 *              the boids take turns, a band of them sensing each step in the
 *              look pass (buildLookShader) and keeping what they sensed (the
 *              flock totals named in def.remember, and the item senses);
 *              the rest recall theirs (lookLayout) instead of scanning
 *   act       species GLSL: forces into the vec2s named in `forces`, and the
 *              new state / aux (/ aux1) into o_state / o_aux (/ o_aux1)
 *
 * The debug variant runs one boid (u_debugId) and writes its forces two per
 * texel, then the seen counts (flock, then each item sense) four per texel,
 * then the species' `signals` (scalars: what it weighed) four per texel, then
 * its state (debugLayout says where).
 */

/** GLSL name of a gene accessor. */
export const geneMacro = (key) => `G_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`

/** Where the debug pass puts each value: forces (2 per texel), counts (4 per texel), signals (4 per texel), state. */
export function debugLayout(def) {
  const forceTexels = Math.ceil(def.forces.length / 2)
  const senses = ['flock', ...itemSenses(def).map((s) => s.key)]
  const countTexels = Math.ceil(senses.length / 4)
  const signals = (def.signals ?? []).map(([key]) => key)
  const signalTexels = Math.ceil(signals.length / 4)
  const stateTexel = forceTexels + countTexels + signalTexels
  return { forceTexels, senses, countTexels, signals, signalTexels, stateTexel, width: stateTexel + 1 }
}

const itemSenses = (def) => def.senses.filter((s) => s.kind === 'items')

/** GLSL: is item source `src` one this sense reads (`source`, or several in `sources`)? */
const sourceTest = (s) => (s.sources ?? [s.source]).map((k) => `src == ${k}`).join(' || ')

/** GLSL: is the item `id` of this sense seen (its `filter`, and a `weight` above 0)? */
const seenTest = (s) => `(${s.filter ?? 'true'})${s.weight ? ` && (${s.weight}) > 0.0` : ''}`

function geneInputs(def) {
  const T = Math.max(1, Math.ceil(def.genes.length / 4))
  const macros = def.genes.map((g, k) => `#define ${geneMacro(g.key)} texelFetch(u_genes, ivec2(own.x * ${T} + ${k >> 2}, own.y), 0).${'xyzw'[k & 3]}`).join('\n')
  return `uniform sampler2D u_genes; // ${T} texel(s) per boid, side by side\n${macros}`
}

const aux1Input = (def) => ((def.auxTextures ?? 1) > 1 ? 'uniform sampler2D u_aux1;' : '') + (def.vertical ? '\nuniform sampler2D u_vert; // (z, vz, -, -): height (px, + up from the water surface) and its rate' : '')
const aux1Read = (def) => ((def.auxTextures ?? 1) > 1 ? '\n  vec4 aux1 = texelFetch(u_aux1, own, 0);' : '') + (def.vertical ? '\n  vec4 vert = texelFetch(u_vert, own, 0);' : '')
/** The update's outputs after state and aux: aux1, then vert (as BoidKernel's extras). */
const extraOuts = (def) => [...((def.auxTextures ?? 1) > 1 ? ['aux1'] : []), ...(def.vertical ? ['vert'] : [])]

function itemDecls(def) {
  return itemSenses(def)
    .map((s) => `  vec2 P_${s.key} = vec2(0.0);\n  int N_${s.key} = 0;\n  vec4 NEAR_${s.key} = vec4(0.0, 0.0, -1.0, 1e9);`)
    .join('\n')
}

/** Every item sense in one pass over the grid (fills P_, N_, NEAR_, declared by itemDecls). */
function itemScan(def) {
  const senses = itemSenses(def)
  const visit = senses
    .map(
      (s, k) => `${k ? 'else ' : ''}if (${sourceTest(s)}) {
            float w = N_${s.key} < MAX_ITEMS && (${s.filter ?? 'true'}) ? ${s.weight ?? '1.0'} : 0.0;
            if (w > 0.0) {
              N_${s.key}++;
              if (dd > 1e-3) P_${s.key} += d * ((1.0 - dd / RANGE) / dd * w);
              if (dd < NEAR_${s.key}.w) NEAR_${s.key} = vec4(it.xy, id, dd);
            }
          }`,
    )
    .join(' ')
  const clamp = senses.map((s) => `  if (length(P_${s.key}) > 1.0) P_${s.key} = normalize(P_${s.key});`).join('\n')
  return `
  // Items: every source in one pass over the grid cells within RANGE, nearest
  // ring of cells first, at most MAX_ITEM_SCAN items looked at in all (and
  // MAX_ITEMS of one sense weighed). Each cell is read from a different
  // place per boid, so in a dense patch not everyone weighs the same few.
  {
    ivec2 ic = ivec2(floor(pos / u_itemCell));
    int rr = RANGE > 0.0 ? int(ceil(RANGE / u_itemCell)) : -1;
    int scanLeft = MAX_ITEM_SCAN;
    for (int ring = 0; ring <= rr && scanLeft > 0; ring++) {
      for (int gy = -ring; gy <= ring && scanLeft > 0; gy++) {
        for (int gx = -ring; gx <= ring && scanLeft > 0; gx++) {
          if (max(abs(gx), abs(gy)) != ring) continue;
          ivec2 g = ic + ivec2(gx, gy);
          if (any(lessThan(g, ivec2(0))) || any(greaterThanEqual(g, u_itemGrid))) continue;
          int cid = g.y * u_itemGrid.x + g.x;
          ivec2 cr = ivec2(texelFetch(u_itemCells, ivec2(cid % u_itemCellsW, cid / u_itemCellsW), 0).xy);
          int len = cr.y - cr.x;
          int n = min(len, scanLeft);
          scanLeft -= n;
          int k = len > 0 ? self % len : 0;
          for (int j = 0; j < n; j++) {
            int idx = cr.x + k;
            if (++k == len) k = 0;
            vec4 it = texelFetch(u_items, ivec2(idx % u_itemsW, idx / u_itemsW), 0);
            vec2 d = it.xy - pos;
            float dd = length(d);
            if (dd > RANGE) continue;
            float id = it.z;
            int src = int(it.w);
            ${visit}
          }
        }
      }
    }
  }
${clamp}`
}

const flockInputs = () => `uniform sampler2D u_sorted;
uniform usampler2D u_cellTable;
uniform vec2 u_cellSize;
uniform ivec2 u_grid;
uniform int u_cellTexW;
uniform int u_maxNeighbors;
uniform int u_scanBudget; // most candidates a boid looks at, so crowds cost a bounded amount
uniform float u_drift;    // how far any boid may have moved since the grid was sorted (px)

// Grid cells, nearest first, out to 2 cells: cells are at least half the
// largest range wide, so that covers it.
const ivec2 CELL_ORDER[25] = ivec2[25](
  ivec2(0, 0), ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1),
  ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2),
  ivec2(2, 1), ivec2(-2, 1), ivec2(2, -1), ivec2(-2, -1),
  ivec2(1, 2), ivec2(-1, 2), ivec2(1, -2), ivec2(-1, -2),
  ivec2(2, 2), ivec2(-2, 2), ivec2(2, -2), ivec2(-2, -2));`

/** Its own kind within RANGE: the species' `visit` for each one seen. */
const flockScan = (def) => `
  // Its own kind: only cells that reach within RANGE, nearest first. Each
  // cell is read starting from a different place per boid, so in a crowd not
  // everyone follows the same few.
  if (FLOCK_ON) {
    float r2 = RANGE * RANGE;
    float reach = RANGE + u_drift; // a neighbour may have left its cell since the sort
    ivec2 cell = clamp(ivec2(floor(pos / u_cellSize)), ivec2(0), u_grid - 1);
    int budget = u_scanBudget;
    for (int o = 0; o < 25 && FLOCK_N < u_maxNeighbors && budget > 0; o++) {
      ivec2 g = cell + CELL_ORDER[o];
      if (any(lessThan(g, ivec2(0))) || any(greaterThanEqual(g, u_grid))) continue;
      vec2 lo = vec2(g) * u_cellSize;
      vec2 gap = max(max(lo - pos, pos - lo - u_cellSize), 0.0);
      if (dot(gap, gap) > reach * reach) continue;
      int cid = g.y * u_grid.x + g.x;
      ivec2 range = ivec2(texelFetch(u_cellTable, ivec2(cid % u_cellTexW, cid / u_cellTexW), 0).xy);
      int len = range.y - range.x;
      int scan = min(len, budget);
      budget -= scan;
      int k = len > 0 ? self % len : 0;
      for (int j = 0; j < scan && FLOCK_N < u_maxNeighbors; j++) {
        vec4 nb = texelFetch(u_sorted, coordOf(range.x + k), 0);
        if (++k == len) k = 0;
        vec2 d = nb.xy - pos;
        float d2 = dot(d, d);
        if (d2 > r2 || d2 < 1e-8) continue; // out of range, or itself
${def.glsl.visit}
      }
    }
  }`

/** Everything it senses now: the flock, then the items, then the species' own (glsl.sense). */
const senseNow = (def) => `${flockScan(def)}${itemSenses(def).length ? `\n${itemScan(def)}` : ''}${def.glsl.sense ? `\n${def.glsl.sense}` : ''}`

/**
 * What a boid keeps between looks, in its own texels of a few RGBA32UI
 * textures (4 channels each, 4 textures at most):
 *   def.remember  its flock totals ({ name: 'int' | 'float' | 'vec2' },
 *                 variables `pre` declares): a vec2 as two halves in one
 *                 channel, a float exactly, an int in 8 bits (0..255)
 *   items         P_<key> (two halves), NEAR_<key> (its place as fractions
 *                 of the world, and its id + 1, 0 for none) where the
 *                 species' GLSL reads them, and every N_<key> in 4 bits
 * The ints and counts share channels. null: nothing to keep (the species
 * then always senses every step).
 */
export function lookLayout(def) {
  const remember = Object.entries(def.remember ?? {})
  const senses = itemSenses(def)
  if (!def.tickParam || (!remember.length && !senses.length)) return null
  const code = `${def.glsl.pre}\n${def.glsl.act}`
  const uses = (name) => new RegExp(`\\b${name}\\b`).test(code)
  const entries = [] // { writes: [uint GLSL per channel], read: (channels) => GLSL }
  const ints = [] // [name, bits]
  for (const [name, type] of remember) {
    if (type === 'int') ints.push([name, 8])
    else if (type === 'vec2') entries.push({ writes: [`packHalf2x16(${name})`], read: ([c]) => `${name} = unpackHalf2x16(${c});` })
    else if (type === 'float') entries.push({ writes: [`floatBitsToUint(${name})`], read: ([c]) => `${name} = uintBitsToFloat(${c});` })
    else throw new Error(`${def.name}: cannot remember ${name} (${type})`)
  }
  for (const s of senses) {
    ints.push([`N_${s.key}`, 4])
    if (uses(`P_${s.key}`)) entries.push({ writes: [`packHalf2x16(P_${s.key})`], read: ([c]) => `P_${s.key} = unpackHalf2x16(${c});` })
    if (!uses(`NEAR_${s.key}`)) continue
    // The nearest seen, still there if still in range (and still seen: filter, weight).
    entries.push({
      writes: [`packUnorm2x16(NEAR_${s.key}.xy / u_world)`, `uint(NEAR_${s.key}.z + 1.0)`],
      read: ([a, i]) => `{
      float id = float(${i}) - 1.0;
      vec2 at = unpackUnorm2x16(${a}) * u_world;
      float dd = distance(at, pos);
      if (id >= 0.0 && dd <= RANGE && ${seenTest(s)}) NEAR_${s.key} = vec4(at, id, dd);
    }`,
    })
  }
  let shift = 0
  const packed = ints.map(([name, bits]) => {
    const at = shift
    shift += bits
    return { name, bits, at }
  })
  if (shift > 32) throw new Error(`${def.name}: too many counts to remember (${shift} bits; 32 at most)`)
  if (packed.length) {
    const max = (b) => (1 << b) - 1
    entries.push({
      writes: [packed.map(({ name, bits, at }) => `uint(clamp(${name}, 0, ${max(bits)})) << ${at}u`).join(' | ')],
      read: ([c]) => packed.map(({ name, bits, at }) => `${name} = int(${c} >> ${at}u & ${max(bits)}u);`).join('\n    '),
    })
  }
  let n = 0
  for (const e of entries) e.channels = e.writes.map(() => n++)
  const textures = Math.ceil(n / 4)
  if (textures > 4) throw new Error(`${def.name}: too much to remember between looks (${n} channels; 16 at most)`)
  return { entries, channels: n, textures }
}

const lookChannel = (c) => `L${c >> 2}.${'xyzw'[c & 3]}`

/** Recalling what it sensed at its last look (lookLayout). */
function recall(L) {
  const lines = []
  for (let t = 0; t < L.textures; t++) lines.push(`    uvec4 L${t} = texelFetch(u_look${t}, own, 0);`)
  for (const e of L.entries) lines.push(`    ${e.read(e.channels.map(lookChannel))}`)
  return lines.join('\n')
}

/** The update's senses: now, or (ticking slower than every step) as last sensed. */
function senseSection(def) {
  const L = lookLayout(def)
  const decls = itemSenses(def).length ? itemDecls(def) : ''
  if (!L) return `${decls}\n${senseNow(def)}`
  return `${decls}
  if (u_lookEvery > 1) {
    // As it sensed at its last look (every u_lookEvery steps, in turn).
${recall(L)}
  } else {${senseNow(def)}
  }`
}

function lookInputs(L) {
  if (!L) return ''
  const samplers = Array.from({ length: L.textures }, (_, t) => `uniform usampler2D u_look${t};`).join('\n')
  return `${samplers}\nuniform int u_lookEvery; // steps between looks (1: every step, no memory)`
}

function itemInputs(def) {
  if (!itemSenses(def).length) return ''
  return `uniform sampler2D u_items;     // every item source, sorted by grid cell: (x, y, id, source)
uniform usampler2D u_itemCells; // [start, end) per grid cell
uniform int u_itemsW;
uniform int u_itemCellsW;
uniform ivec2 u_itemGrid;
uniform float u_itemCell;
const int MAX_ITEMS = 8;       // most items of one sense weighed
const int MAX_ITEM_SCAN = 32;  // most items looked at in all`
}

function debugFind() {
  return `uniform int u_debugId;
uniform sampler2D u_prevState;
// The debug boid's place in the sorted order: binary search for its key as
// hashFS made it at the last sort, a few steps back at most. It was filed
// under a cell near where it is now (or, not in flight, after them all).
ivec2 debugCell() {
  ivec2 me = coordOf(u_debugId);
  ivec2 cell = clamp(ivec2(floor(texelFetch(u_prevState, me, 0).xy / u_cellSize)), ivec2(0), u_grid - 1);
  for (int o = 0; o <= 25; o++) {
    uint cellId = uint(${MAX_CELLS});
    if (o < 25) {
      ivec2 g = cell + CELL_ORDER[o];
      if (any(lessThan(g, ivec2(0))) || any(greaterThanEqual(g, u_grid))) continue;
      cellId = uint(g.y * u_grid.x + g.x);
    }
    uint key = cellId << ${ID_BITS}u | uint(u_debugId);
    int lo = 0;
    int hi = u_count - 1;
    while (lo < hi) {
      int mid = (lo + hi) / 2;
      if (texelFetch(u_sortedKeys, coordOf(mid), 0).x < key) lo = mid + 1;
      else hi = mid;
    }
    if (texelFetch(u_sortedKeys, coordOf(lo), 0).x == key) return coordOf(lo);
  }
  return ivec2(0);
}`
}

function debugOut(def) {
  const L = debugLayout(def)
  const f = def.forces.map(([, glsl]) => glsl)
  const lines = []
  for (let t = 0; t < L.forceTexels; t++) lines.push(`  if (t == ${t}) o_state = vec4(${f[t * 2]}, ${f[t * 2 + 1] ?? 'vec2(0.0)'});`)
  const counts = ['float(FLOCK_N)', ...itemSenses(def).map((s) => `float(N_${s.key})`)]
  for (let t = 0; t < L.countTexels; t++) {
    const c = counts.slice(t * 4, t * 4 + 4)
    while (c.length < 4) c.push('0.0')
    lines.push(`  if (t == ${L.forceTexels + t}) o_state = vec4(${c.join(', ')});`)
  }
  const sig = (def.signals ?? []).map(([, glsl]) => `float(${glsl})`)
  for (let t = 0; t < L.signalTexels; t++) {
    const c = sig.slice(t * 4, t * 4 + 4)
    while (c.length < 4) c.push('0.0')
    lines.push(`  if (t == ${L.forceTexels + L.countTexels + t}) o_state = vec4(${c.join(', ')});`)
  }
  lines.push(`  if (t == ${L.stateTexel}) o_state = vec4(DEBUG_POS, DEBUG_VEL);`)
  return `  int t = int(gl_FragCoord.x);\n${lines.join('\n')}`
}

/** The update shader of species `def` (the debug variant if `debug`). */
export function buildUpdateShader(def, debug = false) {
  const g = def.glsl
  return `${HEADER}
uniform sampler2D u_aux;   // previous aux (species-defined)
uniform sampler2D u_traits; // per-boid constants
uniform usampler2D u_sortedKeys;
uniform int u_count;
uniform vec2 u_world;
uniform vec2 u_rescale;
uniform float u_dt;
uniform float u_time;
${flockInputs()}
${geneInputs(def)}
${itemInputs(def)}
${lookInputs(lookLayout(def))}
${aux1Input(def)}
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;
${extraOuts(def).map((n, i) => `layout(location = ${i + 2}) out vec4 o_${n};`).join('\n')}
${g.decl}
${debug ? debugFind() : ''}

void main() {
  ivec2 c = ${debug ? 'debugCell()' : 'ivec2(gl_FragCoord.xy)'};
  int self = indexOf(c);
  if (self >= u_count) { o_state = vec4(0.0); o_aux = vec4(0.0);${extraOuts(def).map((n) => ` o_${n} = vec4(0.0);`).join('')} return; }
  ivec2 own = coordOf(int(texelFetch(u_sortedKeys, c, 0).x & ID_MASK)); // this boid's own texel
  vec4 s = texelFetch(u_sorted, c, 0);
  vec2 pos = s.xy * u_rescale;
  vec2 vel = s.zw;
  vec4 aux = texelFetch(u_aux, own, 0);${aux1Read(def)}
${g.pre}
${senseSection(def)}

${g.act}
${debug ? debugOut(def) : ''}
}
`
}

/**
 * The look pass (lookLayout; run when the tick rate is above 1): at each
 * boid's own texel, those whose turn it is sense the flock and items as the
 * update would and keep it. Turns go by bands of rows, and the pass is drawn
 * over that band alone (the kernel's viewport), so the rest cost nothing.
 */
export function buildLookShader(def) {
  const L = lookLayout(def)
  const g = def.glsl
  const outs = Array.from({ length: L.textures }, (_, t) => `layout(location = ${t}) out uvec4 o_look${t};`).join('\n')
  const flat = []
  for (const e of L.entries) flat.push(...e.writes)
  const writes = Array.from({ length: L.textures }, (_, t) => {
    const c = flat.slice(t * 4, t * 4 + 4)
    while (c.length < 4) c.push('0u')
    return `  o_look${t} = uvec4(${c.join(', ')});`
  }).join('\n')
  return `${HEADER}
uniform sampler2D u_prevState; // state at each boid's own texel
uniform sampler2D u_aux;
uniform sampler2D u_traits;
uniform int u_count;
uniform vec2 u_world;
uniform vec2 u_rescale;
uniform float u_dt;
uniform float u_time;
${flockInputs()}
${geneInputs(def)}
${itemInputs(def)}
${aux1Input(def)}
${outs}
${g.decl}

void main() {
  ivec2 own = ivec2(gl_FragCoord.xy);
  int self = indexOf(own);
  if (self >= u_count) discard;
  vec4 s = texelFetch(u_prevState, own, 0);
  vec2 pos = s.xy * u_rescale;
  vec2 vel = s.zw;
  vec4 aux = texelFetch(u_aux, own, 0);${aux1Read(def)}
${g.pre}
${itemSenses(def).length ? itemDecls(def) : ''}
${senseNow(def)}
${writes}
}
`
}
