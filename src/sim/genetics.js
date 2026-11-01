/**
 * Genomes shared by the evolving creatures (midges, dragonflies): a genome is
 * an array of numbers, one per gene of a gene list ({ key, min, max, ... }).
 */

/** A random genome, uniform over the gene ranges. */
export function randomGenome(genes) {
  return genes.map((g) => g.min + Math.random() * (g.max - g.min))
}

/** A genome as { key: value }, and back (missing genes are drawn at random, the rest clamped). */
export function genomeToObject(genes, genome) {
  return Object.fromEntries(genes.map((g, k) => [g.key, genome[k]]))
}
export function objectToGenome(genes, obj) {
  return genes.map((g) => {
    const v = Number(obj?.[g.key])
    return Number.isFinite(v) ? Math.min(g.max, Math.max(g.min, v)) : g.min + Math.random() * (g.max - g.min)
  })
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
}

/** A copy of a genome, each gene mutated with chance `rate` by about `size` of its range. */
export function mutate(genes, genome, rate, size) {
  return Array.from(genome, (v, k) => {
    if (Math.random() >= rate) return v
    const g = genes[k]
    return Math.min(g.max, Math.max(g.min, v + gauss() * size * (g.max - g.min)))
  })
}

/** Mean and spread of each gene over the genomes in `pool` (flat, `n` genes each) at the given slots. */
export function summarize(genes, pool, slots) {
  const n = genes.length
  const sum = new Float64Array(n)
  const sq = new Float64Array(n)
  for (const i of slots) {
    for (let k = 0; k < n; k++) {
      const v = pool[i * n + k]
      sum[k] += v
      sq[k] += v * v
    }
  }
  const mean = Array.from(sum, (s) => s / slots.length)
  const spread = mean.map((m, k) => Math.sqrt(Math.max(0, sq[k] / slots.length - m * m)))
  return { genes: genomeToObject(genes, mean), spread: genomeToObject(genes, spread) }
}
