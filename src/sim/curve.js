/**
 * A curve through points [[x, y], ...] (x ascending, from 0 to 1): monotone
 * cubic (Fritsch-Carlson), so it passes through every point and never
 * overshoots between two (no bumps above or dips below them). Flat beyond
 * the ends.
 */
export function evalCurve(points, x) {
  const n = points.length
  if (!n) return 0
  if (x <= points[0][0]) return points[0][1]
  if (x >= points[n - 1][0]) return points[n - 1][1]
  let i = 0
  while (x > points[i + 1][0]) i++
  const m = tangents(points)
  const [x0, y0] = points[i]
  const [x1, y1] = points[i + 1]
  const h = x1 - x0
  if (h <= 0) return y1
  const t = (x - x0) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1]
}

/** Slopes at the points, limited so each segment stays monotone. Cached per points array. */
const cache = new WeakMap()
function tangents(points) {
  let m = cache.get(points)
  if (m) return m
  const n = points.length
  const s = []
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1][0] - points[i][0]
    s.push(h > 0 ? (points[i + 1][1] - points[i][1]) / h : 0)
  }
  m = new Array(n).fill(0)
  m[0] = s[0] ?? 0
  m[n - 1] = s[n - 2] ?? 0
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / s[i]
    const b = m[i + 1] / s[i]
    const r = a * a + b * b
    if (r > 9) {
      const k = 3 / Math.sqrt(r)
      m[i] = k * a * s[i]
      m[i + 1] = k * b * s[i]
    }
  }
  cache.set(points, m)
  return m
}
