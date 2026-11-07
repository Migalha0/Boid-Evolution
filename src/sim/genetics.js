/**
 * Genomes shared by the evolving creatures (midges, dragonflies): a genome is
 * an array of numbers, one per gene of a gene list ({ key, min, max, ... }).
 *
 * Wiring genes (`bits`: how many) are not amounts but packed links, one bit
 * each (species/midges.js wiring): drawn by the gene's own `random(params)`,
 * rewired (each link's chance `wireRate` of a rewiring, which as likely makes
 * a link as breaks one), never mutated by size or sign, averaged as the share
 * of genomes that have each link, and when missing drawn at random.
 *
 * Choice genes (`choices`: how many, e.g. a link's activation function) are
 * an index 0..choices-1: drawn evenly, a mutation switches to another one at
 * random, and the population's is the most common one.
 *
 * Fixed genes (`fixed`) are always their `default`: never drawn, mutated, or
 * taken from a profile (they are in the genome so they can evolve later).
 */

/** A random genome: uniform over the gene ranges (wiring genes by their own `random`). */
export function randomGenome(genes, params) {
  return genes.map((g) => (g.fixed ? g.default : g.random ? g.random(params) : g.choices ? Math.floor(Math.random() * g.choices) : g.min + Math.random() * (g.max - g.min)))
}

/**
 * How far a gene can go either way: mutation may flip its sign, so every gene
 * lives in ±(the larger end of its range); random genomes still start in it.
 */
export function geneLimit(g) {
  return Math.max(Math.abs(g.min), Math.abs(g.max))
}

/** A genome as { key: value }, and back (missing genes are their `default` or drawn at random, wiring by `params`; the rest clamped). */
export function genomeToObject(genes, genome) {
  return Object.fromEntries(genes.map((g, k) => [g.key, genome[k]]))
}
export function objectToGenome(genes, obj, params) {
  return genes.map((g) => {
    if (g.fixed) return g.default
    const v = Number(obj?.[g.key])
    if (!Number.isFinite(v)) return g.default ?? (g.random ? g.random(params) : g.choices ? Math.floor(Math.random() * g.choices) : g.min + Math.random() * (g.max - g.min))
    if (g.bits) return Math.min(2 ** g.bits - 1, Math.max(0, Math.round(v)))
    if (g.choices) return Math.min(g.choices - 1, Math.max(0, Math.round(v)))
    const lim = geneLimit(g)
    return Math.min(lim, Math.max(-lim, v))
  })
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
}

/** Knuth's Poisson sampler: how many events, at mean `lambda`. */
export function poisson(lambda) {
  if (!(lambda > 0)) return 0
  const limit = Math.exp(-lambda)
  let k = 0
  let prod = Math.random()
  while (prod > limit) {
    k++
    prod *= Math.random()
  }
  return k
}

/**
 * A copy of a genome, mutated (p: the params mutationCount, mutationSize,
 * mutationRelative, mutationFlip, wireRate):
 *
 * - How many genes mutate: a Poisson count, its mean the background
 *   `mutationCount` plus the genome's own `mutCount` gene (if it has one;
 *   below 0 counts as 0); each mutation picks a gene at random (not the
 *   wiring genes).
 * - How much: σ = `mutationSize` plus its own `mutSigma` gene. A share r
 *   (`mutationRelative`) of it scales the gene, the rest adds to it:
 *   v' = v·(1 + σ·r)^Z + Z'·σ·(1 − r)·range (Z, Z' standard normal). The
 *   scaling part can't cross 0; the adding part can. `relative` genes (rates)
 *   are scaled only (r = 1), never flipped, and kept within min..max.
 * - Chance `mutationFlip` of a mutation flips the gene's sign instead; a
 *   choice gene switches to another choice.
 * - The wiring genes get a rewiring with chance `wireRate` per link they can
 *   hold, each a coin toss between making a link (one of those it lacks, at
 *   random) and breaking one (of those it has): so links are as likely
 *   gained as lost, whatever how many it has.
 */
export function mutate(genes, genome, p) {
  const at = (key) => genes.findIndex((g) => g.key === key)
  const own = (key) => {
    const k = at(key)
    return k >= 0 ? Math.max(0, genome[k]) : 0
  }
  const out = Array.from(genome)
  const pickable = genes.flatMap((g, k) => (g.bits || g.fixed ? [] : [k]))
  const sigma = (p.mutationSize ?? 0) + own('mutSigma')
  const count = poisson((p.mutationCount ?? 0) + own('mutCount'))
  for (let n = 0; n < count && pickable.length; n++) {
    const k = pickable[(Math.random() * pickable.length) | 0]
    const g = genes[k]
    const v = out[k]
    if (g.choices) {
      out[k] = (v + 1 + Math.floor(Math.random() * (g.choices - 1))) % g.choices // another one
      continue
    }
    if (!g.relative && Math.random() < (p.mutationFlip ?? 0)) {
      out[k] = -v
      continue
    }
    const r = g.relative ? 1 : (p.mutationRelative ?? 0.75)
    const next = v * (1 + sigma * r) ** gauss() + gauss() * sigma * (1 - r) * (g.max - g.min)
    const lim = geneLimit(g)
    out[k] = g.relative ? Math.min(g.max, Math.max(g.min, next)) : Math.min(lim, Math.max(-lim, next))
  }
  const wireRate = p.wireRate ?? 0
  if (wireRate > 0) {
    const bits = [] // every link it can hold: [gene, bit]
    genes.forEach((g, k) => {
      for (let b = 0; b < (g.bits ?? 0); b++) bits.push([k, b])
    })
    for (let n = 0; n < bits.length; n++) {
      if (Math.random() >= wireRate) continue
      const make = Math.random() < 0.5
      const pick = bits.filter(([k, b]) => ((out[k] >> b) & 1) === (make ? 0 : 1))
      if (!pick.length) continue
      const [k, b] = pick[(Math.random() * pick.length) | 0]
      out[k] ^= 1 << b
    }
  }
  return out
}

/**
 * Mean and spread of each gene over the genomes in `pool` (flat, `n` genes
 * each) at the given slots. Wiring genes: `wiring`, the share of genomes
 * with each link (every wiring gene's bits in turn), and as their mean the
 * links most have (spread 0).
 */
export function summarize(genes, pool, slots) {
  const n = genes.length
  const sum = new Float64Array(n)
  const sq = new Float64Array(n)
  const links = new Float64Array(genes.reduce((t, g) => t + (g.bits ?? 0), 0))
  const votes = genes.map((g) => (g.choices ? new Float64Array(g.choices) : null))
  for (const i of slots) {
    let at = 0
    for (let k = 0; k < n; k++) {
      const v = pool[i * n + k]
      if (genes[k].bits) {
        for (let b = 0; b < genes[k].bits; b++) links[at + b] += (v >> b) & 1
        at += genes[k].bits
        continue
      }
      if (votes[k]) votes[k][Math.min(genes[k].choices - 1, Math.max(0, Math.round(v)))]++
      sum[k] += v
      sq[k] += v * v
    }
  }
  const wiring = Array.from(links, (c) => c / slots.length)
  const mean = Array.from(sum, (s) => s / slots.length)
  const spread = mean.map((m, k) => Math.sqrt(Math.max(0, sq[k] / slots.length - m * m)))
  genes.forEach((g, k) => {
    if (!votes[k]) return
    mean[k] = votes[k].indexOf(Math.max(...votes[k])) // the most common
    spread[k] = 0
  })
  let at = 0
  genes.forEach((g, k) => {
    if (!g.bits) return
    let w = 0
    for (let b = 0; b < g.bits; b++) if (wiring[at + b] > 0.5) w |= 1 << b
    at += g.bits
    mean[k] = w
    spread[k] = 0
  })
  return { genes: genomeToObject(genes, mean), spread: genomeToObject(genes, spread), wiring }
}
