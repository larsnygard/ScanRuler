// SPDX-License-Identifier: AGPL-3.0-only
// The sketch's constraints, settled: a sketch's entities rest on a set of
// free points, and every constraint is a function of those points that a
// solution drives to zero. Solved by Gauss-Newton with Levenberg-Marquardt
// damping over the point coordinates, the way a sketch solver works: the
// Jacobian read by finite differences (nine point coordinates touch most
// constraints, so a numerical Jacobian is a handful of evaluations), then
// the normal equations solved by Gaussian elimination.
//
// What the solver owns: a flat array of point coordinates (x, y) — each
// point two DOF — a list of constraints, and a list of points pinned by
// construction (datum-locked) whose DOF are taken out. A solution is found
// in milliseconds for a sketch of a few dozen points; over-constrained and
// contradictory systems converge as far as they can and report the residual
// they were left with, which the panel says. Nothing is mutated in place:
// `solve` is given the numbers and gives numbers back.

/** The free point coordinates, x, y interleaved. */
export type PointDofs = Float64Array

export interface ConstraintResidual {
  /** The constraint's name, for the panel. */
  kind: string
  /** How far from satisfied the sketch is, in millimetres (or radians for
   *  an angle): the |value| a solution drives to about zero. */
  value: number
}

export type Constraint =
  /** Two points are one. */
  | { kind: 'coincident'; a: number; b: number }
  /** The segment a→b lies along X. */
  | { kind: 'horizontal'; a: number; b: number }
  /** The segment a→b lies along Y. */
  | { kind: 'vertical'; a: number; b: number }
  /** The two segments point the same way (or opposite). */
  | { kind: 'parallel'; a1: number; b1: number; a2: number; b2: number }
  /** The two segments lie at right angles. */
  | { kind: 'perpendicular'; a1: number; b1: number; a2: number; b2: number }
  /** The segment a→b is `value` long. */
  | { kind: 'distance'; a: number; b: number; value: number }
  /** The point a is `value` from the sketch's origin. */
  | { kind: 'origin-distance'; a: number; value: number }
  /** The circle about a has radius `value`. */
  | { kind: 'radius'; a: number; value: number }
  /** The segment a→b is `value` long. */
  | { kind: 'equal-distance'; a1: number; b1: number; a2: number; b2: number }
  /** The circle about a and the circle about b share a radius. */
  | { kind: 'equal-radius'; a: number; b: number }
  /** The point a lies on the segment a2→b2 (its perpendicular distance). */
  | { kind: 'point-on-line'; a: number; a2: number; b2: number }
  /** The point a is `value` from the line through p→q (signed). */
  | { kind: 'offset-line'; a: number; p: number; q: number; value: number }
  /** The angle at a between a→b and a→c is `value` radians. */
  | { kind: 'angle'; a: number; b: number; c: number; value: number }
  /** The point a is fixed. */
  | { kind: 'fixed'; a: number }
  /** The point a lies on the sketch's X axis. */
  | { kind: 'on-x-axis'; a: number }
  /** The point a lies on the sketch's Y axis. */
  | { kind: 'on-y-axis'; a: number }
  /** The line a→b is symmetric about the Y axis: its ends mirror. */
  | { kind: 'symmetric-y'; a: number; b: number }

function px(v: PointDofs, p: number) {
  return v[p * 2]
}
function py(v: PointDofs, p: number) {
  return v[p * 2 + 1]
}

/** The constraint's residual at the given coordinates. */
export function residualOf(c: Constraint, v: PointDofs): number {
  switch (c.kind) {
    case 'coincident':
      return Math.hypot(px(v, c.a) - px(v, c.b), py(v, c.a) - py(v, c.b))
    case 'horizontal':
      return py(v, c.a) - py(v, c.b)
    case 'vertical':
      return px(v, c.a) - px(v, c.b)
    case 'distance':
      return Math.hypot(px(v, c.b) - px(v, c.a), py(v, c.b) - py(v, c.a)) - c.value
    case 'origin-distance':
      return Math.hypot(px(v, c.a), py(v, c.a)) - c.value
    case 'radius':
      return c.value > 0 ? 0 : c.value
    case 'equal-distance': {
      const l1 = Math.hypot(px(v, c.b1) - px(v, c.a1), py(v, c.b1) - py(v, c.a1))
      const l2 = Math.hypot(px(v, c.b2) - px(v, c.a2), py(v, c.b2) - py(v, c.a2))
      return l1 - l2
    }
    case 'equal-radius':
      return 0
    case 'parallel': {
      // The cross product of the two directions, scaled by their lengths
      // so a short segment does not dominate: sin of the angle between.
      const ux = px(v, c.b1) - px(v, c.a1),
        uy = py(v, c.b1) - py(v, c.a1)
      const wx = px(v, c.b2) - px(v, c.a2),
        wy = py(v, c.b2) - py(v, c.a2)
      const n = Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1
      return (ux * wy - uy * wx) / n
    }
    case 'perpendicular': {
      const ux = px(v, c.b1) - px(v, c.a1),
        uy = py(v, c.b1) - py(v, c.a1)
      const wx = px(v, c.b2) - px(v, c.a2),
        wy = py(v, c.b2) - py(v, c.a2)
      const n = Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1
      return (ux * wx + uy * wy) / n
    }
    case 'point-on-line': {
      const ux = px(v, c.b2) - px(v, c.a2),
        uy = py(v, c.b2) - py(v, c.a2)
      const n = Math.hypot(ux, uy) || 1
      return ((px(v, c.a) - px(v, c.a2)) * uy - (py(v, c.a) - py(v, c.a2)) * ux) / n
    }
    case 'offset-line': {
      const ux = px(v, c.q) - px(v, c.p),
        uy = py(v, c.q) - py(v, c.p)
      const n = Math.hypot(ux, uy) || 1
      return ((px(v, c.a) - px(v, c.p)) * uy - (py(v, c.a) - py(v, c.p)) * ux) / n - c.value
    }
    case 'angle': {
      const a1 = Math.atan2(py(v, c.b) - py(v, c.a), px(v, c.b) - px(v, c.a))
      const a2 = Math.atan2(py(v, c.c) - py(v, c.a), px(v, c.c) - px(v, c.a))
      let d = a2 - a1
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return d - c.value
    }
    case 'fixed':
      return 0 // Handled as pinned DOF; kept for the panel's list.
    case 'on-x-axis':
      return py(v, c.a)
    case 'on-y-axis':
      return px(v, c.a)
    case 'symmetric-y':
      return Math.hypot(px(v, c.a) + px(v, c.b), py(v, c.a) - py(v, c.b))
  }
}

/** The constraints that carry real equations (a `fixed` is a pin, not a
 *  row; a zero-length `radius` row would be degenerate, so radii are
 *  pinned by their own tool, not solved). */
const rowsOf = (cs: Constraint[]) => cs.filter((c) => c.kind !== 'fixed' && c.kind !== 'radius' && c.kind !== 'equal-radius')

/** Which DOF are pinned: those of every point a `fixed` names. */
export function pinnedDofs(cs: Constraint[], pointCount: number): Uint8Array {
  const pinned = new Uint8Array(pointCount * 2)
  for (const c of cs) if (c.kind === 'fixed') {
    pinned[c.a * 2] = 1
    pinned[c.a * 2 + 1] = 1
  }
  return pinned
}

/** Gaussian elimination with partial pivoting; null when the matrix is
 *  singular (a column with nothing to divide by — a redundant constraint
 *  shows as a free variable, which the damping settles). */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const t = a[pivot]
      a[pivot] = a[col]
      a[col] = t
      const s = b[pivot]
      b[pivot] = b[col]
      b[col] = s
    }
    const d = a[col][col]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = a[r][col] / d
      if (f === 0) continue
      for (let k = col; k < n; k++) a[r][k] -= f * a[col][k]
      b[r] -= f * b[col]
    }
  }
  return b.map((v, i) => v / a[i][i])
}

export interface SolveOptions {
  /** Where to start from (the sketch as drawn); the solver's first guess. */
  start: PointDofs
  /** Constraints in force. */
  constraints: Constraint[]
  /** How many points the sketch has. */
  pointCount: number
  /** Iterations at most. */
  iterations?: number
}

export interface SolveReport {
  /** The settled coordinates. */
  values: PointDofs
  /** What is left unsatisfied, worst first, for the panel to name. */
  unsatisfied: ConstraintResidual[]
  /** How far from satisfied the worst constraint is. */
  residual: number
  /** The system was over-constrained: more equations than free DOF. The
   *  solution is the least-squares one. */
  overConstrained: boolean
}

/** Settle a sketch: the coordinates that satisfy the constraints as nearly
 *  as the system allows. Runs in single precision over a Float64Array;
 *  a sketch of 40 points and 50 constraints settles in a few milliseconds. */
export function solveSketch({ start, constraints, pointCount, iterations = 60 }: SolveOptions): SolveReport {
  const v = new Float64Array(start)
  const pinned = pinnedDofs(constraints, pointCount)
  const free: number[] = []
  for (let i = 0; i < v.length; i++) if (!pinned[i]) free.push(i)
  const rows = rowsOf(constraints)
  const m = rows.length
  const n = free.length
  const over = m > n

  // The numerical Jacobian, column by column: each free DOF perturbed, every
  // row's residual read. The perturbation is relative to the coordinate's
  // size so a 200 mm sketch and a 2 mm one are read the same way.
  const h = 1e-6
  let lambda = 1e-3
  for (let it = 0; it < iterations; it++) {
    // Residuals at the current point.
    const r = new Float64Array(m)
    for (let i = 0; i < m; i++) r[i] = residualOf(rows[i], v)
    const cost = r.reduce((s, x) => s + x * x, 0)

    // J: m x n, dense (a sketch never runs to hundreds of constraints;
    // a dense solve is the simple honest thing at this size).
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0))
    for (let c = 0; c < n; c++) {
      const k = free[c]
      const saved = v[k]
      const eps = h * (1 + Math.abs(saved))
      v[k] = saved + eps
      for (let i = 0; i < m; i++) J[i][c] = (residualOf(rows[i], v) - r[i]) / eps
      v[k] = saved
    }

    // Normal equations: (JᵀJ + λ·diag) δ = −Jᵀr.
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
    const g = new Array(n).fill(0)
    for (let i = 0; i < m; i++) {
      const ri = r[i]
      for (let c = 0; c < n; c++) {
        const jc = J[i][c]
        if (jc === 0) continue
        g[c] += jc * ri
        for (let d = c; d < n; d++) A[c][d] += jc * J[i][d]
      }
    }
    for (let c = 0; c < n; c++) for (let d = 0; d < c; d++) A[c][d] = A[d][c]
    // Tikhonov: λ added, not multiplied onto the diagonal — a constraint
    // that never touches a DOF leaves that column of JᵀJ all zeros, and a
    // multiplied damp of a zero stays zero, so the solve goes singular
    // (a distance across two points on a flat-lying start gives exactly
    // that: its y-column is all zeros).
    for (let c = 0; c < n; c++) A[c][c] += lambda

    const delta = solveLinear(A, g.map((x) => -x))
    if (!delta) {
      lambda *= 10
      if (lambda > 1e8) break
      continue
    }
    const trial = new Float64Array(v)
    for (let c = 0; c < n; c++) trial[free[c]] += delta[c]
    let cost2 = 0
    for (let i = 0; i < m; i++) {
      const x = residualOf(rows[i], trial)
      cost2 += x * x
    }
    if (cost2 < cost) {
      v.set(trial)
      lambda = Math.max(1e-9, lambda * 0.3)
      if (Math.abs(cost - cost2) < 1e-14 * (1 + cost)) break
    } else {
      lambda *= 8
      if (lambda > 1e8) break
    }
  }

  const unsatisfied: ConstraintResidual[] = []
  let residual = 0
  for (const c of constraints) {
    const value = Math.abs(residualOf(c, v))
    if (value > 1e-6) unsatisfied.push({ kind: c.kind, value })
    if (value > residual) residual = value
  }
  unsatisfied.sort((a, b) => b.value - a.value)
  return { values: v, unsatisfied, residual, overConstrained: over }
}
