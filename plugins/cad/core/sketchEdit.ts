// SPDX-License-Identifier: AGPL-3.0-only
// The sketch as it is edited: the operations the editor and the agent
// commands perform on a sketch's entities and constraints. The geometry
// itself (loops, islands, areas) belongs to sketch2d.ts and the settling
// of constraints to solver2d.ts; this file is the editing layer between
// them and the panel: add an entity, weld a drawn end onto an existing
// vertex, drag a point (pinned, solved, settled), constrain a pair,
// delete a piece and take its constraints with it, and guess what the
// person drew (horizontal, vertical, tangent).
//
// Everything here is pure: a sketch doc in, a sketch doc out, the solve
// synchronously in the thread (a few dozen points settle in milliseconds).
// Points are named by their solver index — the flat (x, y) index
// sketchToDofs gives them — which `cad.status` answers as the sketch's
// `points`, so the agent and the editor name a point the same way.

import type { Constraint } from './solver2d'
import { solveSketch } from './solver2d'
import { applyDofs, sketchToDofs } from './part'
import type { SketchEntity } from './types'

/** Two points this far apart are one, in the sketch's millimetres. The
 *  sketch's points are [x, y] tuples (sketch2d's Point2D is the same
 *  place named as fields); this is the tuple's own reading. */
export const dist2 = (a: Point2, b: Point2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** A sketch as it is edited: its entities and the constraints in force. */
export interface SketchDoc {
  entities: SketchEntity[]
  constraints: Constraint[]
}

export type Point2 = [number, number]

/** One point of a sketch, named and located: solver index, the entity it
 *  belongs to, which of that entity's defining points it is (a line's
 *  `from`/`to`, a circle's `center`/radius handle, an arc's
 *  `center`/`from`/`to`, a spline's k), and its coordinates. */
export interface SketchPoint {
  index: number
  entity: number
  slot: number
  at: Point2
}

/** The slot a point is, for the panel's words. */
export function slotName(e: SketchEntity, slot: number): string {
  switch (e.kind) {
    case 'line':
      return slot === 0 ? 'from' : 'to'
    case 'circle':
      return slot === 0 ? 'center' : 'radius'
    case 'arc':
      return slot === 0 ? 'center' : slot === 1 ? 'from' : 'to'
    case 'spline':
      return `point ${slot + 1}`
  }
}

/** Every point of every entity, in solver order. */
export function sketchPoints(entities: SketchEntity[]): SketchPoint[] {
  const out: SketchPoint[] = []
  let index = 0
  for (let entity = 0; entity < entities.length; entity++) {
    const e = entities[entity]
    const pts: Point2[] =
      e.kind === 'line'
        ? [e.from, e.to]
        : e.kind === 'circle'
          ? [e.center, [e.center[0] + e.radius, e.center[1]]]
          : e.kind === 'arc'
            ? [
                e.center,
                [e.center[0] + e.radius * Math.cos(e.fromAngle), e.center[1] + e.radius * Math.sin(e.fromAngle)],
                [e.center[0] + e.radius * Math.cos(e.toAngle), e.center[1] + e.radius * Math.sin(e.toAngle)],
              ]
            : e.points
    pts.forEach((at, slot) => out.push({ index: index++, entity, slot, at }))
  }
  return out
}

/** The sketch's coordinates, as the solver takes them. */
export const dofsOf = (doc: SketchDoc) => sketchToDofs(doc.entities)

/** Set one point's coordinates, straight, no solve. */
export function setPoint(entities: SketchEntity[], index: number, at: Point2): SketchEntity[] {
  const dofs = sketchToDofs(entities)
  const values = new Float64Array(dofs.start)
  values[index * 2] = at[0]
  values[index * 2 + 1] = at[1]
  return applyDofs(entities, dofs, values)
}

/** The coordinates of every point a constraint names. */
function constrainedPoints(c: Constraint): number[] {
  const out: number[] = []
  for (const key of ['a', 'b', 'a1', 'b1', 'a2', 'b2', 'p', 'q'] as const) {
    const v = (c as unknown as Record<string, unknown>)[key]
    if (typeof v === 'number') out.push(v)
  }
  return out
}

/** Every constraint's point indices remapped through `map` — used by
 *  deleteEntity, where a deleted entity's points are gone and the later
 *  ones shift. A constraint naming a deleted point is dropped: it no
 *  longer means anything. */
function remapConstraints(constraints: Constraint[], map: (i: number) => number | null): Constraint[] {
  const out: Constraint[] = []
  for (const c of constraints) {
    const touched = constrainedPoints(c)
    if (touched.some((i) => map(i) === null)) continue
    const next = structuredClone(c) as Record<string, unknown>
    for (const key of ['a', 'b', 'a1', 'b1', 'a2', 'b2', 'p', 'q'] as const) {
      const v = next[key]
      if (typeof v === 'number') next[key] = map(v)
    }
    out.push(next as unknown as Constraint)
  }
  return out
}

/** Add an entity at the end. Its points' solver indices are the ones
 *  following the current count — say so the caller can constrain them. */
export function addEntity(doc: SketchDoc, e: SketchEntity): { doc: SketchDoc; base: number } {
  const base = sketchPoints(doc.entities).length
  return { doc: { entities: [...doc.entities, e], constraints: doc.constraints }, base }
}

/** Delete an entity, with every constraint that named its points. The
 *  later entities' constraints reindex to the points that remain. */
export function deleteEntity(doc: SketchDoc, entity: number): SketchDoc {
  const pts = sketchPoints(doc.entities)
  const doomed = new Set(pts.filter((p) => p.entity === entity).map((p) => p.index))
  const count = pts.filter((p) => p.entity < entity).length
  const width = pts.filter((p) => p.entity === entity).length
  const map = (i: number): number | null => (doomed.has(i) ? null : i < count ? i : i - width)
  return {
    entities: doc.entities.filter((_, i) => i !== entity),
    constraints: remapConstraints(doc.constraints, map),
  }
}

/** Move one point and let the sketch settle about it: the dragged point
 *  is pinned (a temporary `fixed`), the constraints pull the rest along,
 *  and the residual the solver was left with is handed back for the
 *  panel's warning. Nothing is solved over unsolvable geometry: with no
 *  constraints the point just moves. */
export function movePoint(doc: SketchDoc, index: number, at: Point2): { doc: SketchDoc; residual: number; unsatisfied: { kind: string; value: number }[] } {
  // A point pinned by a real `fixed` constraint does not move at all.
  if (doc.constraints.some((x) => x.kind === 'fixed' && x.a === index)) return { doc, residual: 0, unsatisfied: [] }
  const moved = setPoint(doc.entities, index, at)
  if (doc.constraints.length === 0) return { doc: { entities: moved, constraints: doc.constraints }, residual: 0, unsatisfied: [] }
  const dofs = sketchToDofs(moved)
  const pinned: Constraint[] = [...doc.constraints, { kind: 'fixed', a: index }]
  const { values, unsatisfied, residual } = solveSketch({ start: dofs.start, constraints: pinned, pointCount: dofs.pointCount })
  return { doc: { entities: applyDofs(moved, dofs, values), constraints: doc.constraints }, residual, unsatisfied }
}

/** The vertex nearest a point, if this close (sketch millimetres): what
 *  a drawn end welds to. */
export function nearestVertex(entities: SketchEntity[], at: Point2, tol: number): SketchPoint | null {
  let best: SketchPoint | null = null
  for (const p of sketchPoints(entities)) {
    if (p.entity === entities.length - 1 && p.slot === 0) continue
    const d = dist2(p.at, at)
    if (d <= tol && (!best || d < dist2(best.at, at))) best = p
  }
  return best
}

/** Weld: snap a point onto a vertex — the coordinates become one, and a
 *  `coincident` constraint keeps them one when the sketch is solved. */
export function weldPoint(doc: SketchDoc, index: number, onto: number): SketchDoc {
  const pts = sketchPoints(doc.entities)
  const at = pts[onto]?.at
  if (!at) return doc
  const entities = setPoint(doc.entities, index, at)
  const snap = (i: number) => (i === index ? onto : i)
  return {
    entities,
    constraints: [
      ...remapConstraints(doc.constraints, snap),
      ...(doc.constraints.some((c) => c.kind === 'coincident' && constrainedPoints(c).includes(index)) ? [] : [{ kind: 'coincident', a: index, b: onto } as Constraint]),
    ],
  }
}

/** Add a constraint, snapping the endpoints it names to each other first
 *  (a coincident between two far-apart ends should not warp the sketch
 *  on the way to being true). */
export function addConstraint(doc: SketchDoc, c: Constraint): SketchDoc {
  if (c.kind === 'coincident') {
    const pts = sketchPoints(doc.entities)
    const a = pts[c.a]
    const b = pts[c.b]
    if (a && b) {
      const mid: Point2 = [(a.at[0] + b.at[0]) / 2, (a.at[1] + b.at[1]) / 2]
      let entities = setPoint(doc.entities, c.b, mid)
      entities = setPoint(entities, c.a, mid)
      return { entities, constraints: [...doc.constraints, c] }
    }
  }
  return { entities: doc.entities, constraints: [...doc.constraints, c] }
}

export function removeConstraint(doc: SketchDoc, i: number): SketchDoc {
  return { entities: doc.entities, constraints: doc.constraints.filter((_, k) => k !== i) }
}

/** What the person drew, read back as constraints: a line along an axis
 *  is constrained to one, ends that meet are welded, a radius equal to
 *  its neighbour's is marked equal, and the first point of a closed
 *  chain on the origin is pinned to it. The panel runs this on
 *  `Infer`; the person adds the rest (distances, angles) themselves. */
export function guessConstraints(doc: SketchDoc): { doc: SketchDoc; added: string[] } {
  const pts = sketchPoints(doc.entities)
  const tol = 1e-3
  const added: string[] = []
  let out: SketchDoc = { entities: doc.entities, constraints: [...doc.constraints] }
  // Points welded to one are one: the coincident pairs' closure, read
  // as roots. A constraint naming welded points means the same under
  // any of them — the weld tool rewrites the constraints of the point
  // it welds — so Infer reads a constraint against this canon, not the
  // raw indices, and stays idempotent on a drawing it just read.
  const parent = new Map<number, number>()
  const root = (i: number): number => {
    let r = i
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    let k = i
    while (parent.has(k) && parent.get(k) !== r) {
      const next = parent.get(k)!
      parent.set(k, r)
      k = next
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = Math.min(root(a), root(b))
    const rb = Math.max(root(a), root(b))
    parent.set(rb, ra)
  }
  for (const c of out.constraints) if (c.kind === 'coincident') union(c.a, c.b)
  const canon = (c: Constraint): string => {
    const idx = constrainedPoints(c).map(root)
    if (c.kind === 'coincident') idx.sort((x, y) => x - y)
    const value = (c as { value?: number }).value ?? null
    return JSON.stringify([c.kind, idx, value])
  }
  const has = (c: Constraint) => out.constraints.some((x) => canon(x) === canon(c))
  const push = (c: Constraint) => {
    if (!has(c)) {
      out.constraints.push(c)
      added.push(c.kind)
    }
  }
  // Weld coincident ends: every pair of points at one place.
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      if (dist2(pts[i].at, pts[j].at) <= tol) {
        const entities = setPoint(out.entities, pts[j].index, pts[i].at)
        out = { entities, constraints: out.constraints }
        push({ kind: 'coincident', a: pts[i].index, b: pts[j].index })
      }
    }
  out.entities.forEach((e, k) => {
    if (e.kind !== 'line') return
    const b = pts.find((p) => p.entity === k && p.slot === 0)!.index
    const t = b + 1
    const ux = Math.abs(e.to[0] - e.from[0])
    const uy = Math.abs(e.to[1] - e.from[1])
    if (uy <= tol * Math.max(1, ux)) push({ kind: 'horizontal', a: b, b: t })
    else if (ux <= tol * Math.max(1, uy)) push({ kind: 'vertical', a: b, b: t })
  })
  // A chain's start on the origin is pinned there.
  const first = pts[0]
  if (first && dist2(first.at, [0, 0]) <= tol) push({ kind: 'fixed', a: first.index })
  return { doc: out, added }
}

/** A rectangle as four lines with welded corners, centred on (cx, cy) —
 *  the panel's rectangle tool and the agent's plate both start here. */
export function rectangle(doc: SketchDoc, cx: number, cy: number, w: number, h: number): { doc: SketchDoc; base: number } {
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  const corners: Point2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const base = sketchPoints(doc.entities).length
  let entities = [...doc.entities]
  for (let k = 0; k < 4; k++) {
    entities.push({ kind: 'line', from: corners[k], to: corners[(k + 1) % 4] })
  }
  let out: SketchDoc = { entities, constraints: doc.constraints }
  // Weld the four corners: line k's 'to' and line k+1's 'from' become one,
  // and the sides are constrained along the axes.
  for (let k = 0; k < 4; k++) {
    out = weldPoint(out, base + (2 * (k + 1)) % 8, base + 2 * k + 1)
    const a = base + 2 * k
    const b = base + 2 * k + 1
    out = addConstraint(out, k % 2 === 0 ? { kind: 'horizontal', a, b } : { kind: 'vertical', a, b })
  }
  return { doc: out, base }
}
