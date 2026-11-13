// SPDX-License-Identifier: AGPL-3.0-only
// The part as the workspace keeps it: a list of parametric features in the
// order they are built. Each names its inputs by index into this same list
// — an extrude's sketch, a boolean's two bodies, a fillet's body — so the
// list alone, and nothing else, says the part. The list is JSON-stable:
// the project saves it as it stands, undo restores it, and a build compares
// it feature by feature to know what to rebuild.
//
// A feature that names a solid — a primitive, an extrude, a boolean, a
// fillet — makes a body; a sketch makes a profile, which is not a body and
// only stands to be pulled. The body a feature makes is known by that
// feature's index: `body: 3` is "the solid feature 3 made".

import type { Vec3 } from '../../../src/core/types'
import type { Constraint, PointDofs } from './solver2d'
import { solveSketch } from './solver2d'
import type { DatumPlane, Placement, SketchEntity } from './types'

export type BooleanOp = 'fuse' | 'cut' | 'intersect'

/** Which edges of a body an edge feature works on: all of them, or the one
 *  nearest a point in the part (the point a pick of the mesh hands back). */
export type EdgeSelection = { which: 'all' } | { which: 'nearest'; point: Vec3 }

/** Which face of a body the shell opens through: the topmost, the
 *  bottommost, or none (a closed hollow). Named by face centre, which is
 *  honest without a mouse. */
export type FaceSelection = { which: 'top' } | { which: 'bottom' } | { which: 'none' }

export type Feature =
  | { id: number; kind: 'box'; name: string; width: number; depth: number; height: number }
  | { id: number; kind: 'cylinder'; name: string; radius: number; height: number }
  | { id: number; kind: 'sphere'; name: string; radius: number }
  | { id: number; kind: 'cone'; name: string; radius1: number; radius2: number; height: number }
  | { id: number; kind: 'torus'; name: string; majorRadius: number; minorRadius: number }
  | { id: number; kind: 'ellipsoid'; name: string; rx: number; ry: number; rz: number }
  | {
      id: number
      kind: 'sketch'
      name: string
      /** The datum plane the sketch lies in. */
      plane: DatumPlane
      /** `'top'` puts the sketch on the top face of the body grown before
       *  it (a pad on a pad); the plain datum otherwise. */
      on: 'datum' | 'top'
      /** How far the sketch is pushed off its plane, along its normal, mm. */
      offset: number
      /** How far the sketch is slid within its plane, x/y mm. */
      shift: [number, number]
      entities: SketchEntity[]
      /** Constraints in force; the sketch is solved before it is pulled. */
      constraints: Constraint[]
      /** The plane the sketch is revolved about, when it is revolved. */
      revolveAxis?: 'x' | 'y' | 'z'
    }
  | { id: number; kind: 'extrude'; name: string; sketch: number; depth: number }
  | { id: number; kind: 'revolve'; name: string; sketch: number; angleDeg: number; axis: 'x' | 'y' | 'z' }
  | { id: number; kind: 'loft'; name: string; sketches: number[]; ruled: boolean }
  | { id: number; kind: 'boolean'; name: string; op: BooleanOp; a: number; b: number }
  | { id: number; kind: 'fillet'; name: string; body: number; radius: number; edges: EdgeSelection }
  | { id: number; kind: 'chamfer'; name: string; body: number; distance: number; edges: EdgeSelection }
  | { id: number; kind: 'shell'; name: string; body: number; thickness: number; open: FaceSelection }
  | { id: number; kind: 'linearPattern'; name: string; body: number; direction: Vec3; spacing: number; count: number }
  | { id: number; kind: 'circularPattern'; name: string; body: number; center: Vec3; axis: 'x' | 'y' | 'z'; angleDeg: number; count: number }
  | { id: number; kind: 'mirror'; name: string; body: number; plane: DatumPlane }
  | { id: number; kind: 'component'; name: string; body: number; placement: Placement }

/** A feature's kind, by index — what the panel and the readout show. */
export const featureKind = (f: Feature): string => f.kind

/** The features as one stable string each: what a build compares to know
 *  what to rebuild. Key order is fixed by the shape of the object as
 *  written above; JSON.stringify of a feature made by these helpers keeps
 *  it, and features are only ever made here. */
export const featureJson = (f: Feature): string => JSON.stringify(f)

/** The body indices a feature reads: the features it depends on. */
export function featureDeps(f: Feature): number[] {
  switch (f.kind) {
    case 'extrude':
    case 'revolve':
      return [f.sketch]
    case 'loft':
      return f.sketches
    case 'boolean':
      return [f.a, f.b]
    case 'fillet':
    case 'chamfer':
    case 'shell':
    case 'linearPattern':
    case 'circularPattern':
    case 'mirror':
    case 'component':
      return [f.body]
    default:
      return []
  }
}

/** A feature's answer from a build: built, and which body it made (its own
 *  index for solids; null for a profile), or why it did not build. */
export type BuildResult = { index: number; ok: true; body: number | null } | { index: number; ok: false; reason: string }

// ---- Sketch ⇄ solver coordinates -------------------------------------------

/** How many solver points a sketch entity carries: a line two, a circle
 *  two (its centre and one point on it — its radius), an arc three (centre,
 *  start, end), a spline one per point. */
export const entityPointCount = (e: SketchEntity): number => (e.kind === 'line' ? 2 : e.kind === 'spline' ? e.points.length : e.kind === 'circle' ? 2 : 3)

export interface SketchDofs {
  /** The flat x,y interleaved coordinates, one entry per point. */
  start: PointDofs
  /** How many points the sketch has. */
  pointCount: number
  /** Per entity, the index of its first solver point. */
  base: number[]
}

/** The sketch's entities as solver coordinates: each entity's defining
 *  points, in order, flat. */
export function sketchToDofs(entities: SketchEntity[]): SketchDofs {
  const base: number[] = []
  let n = 0
  for (const e of entities) {
    base.push(n)
    n += entityPointCount(e)
  }
  const start = new Float64Array(n * 2)
  const put = (i: number, p: [number, number]) => {
    start[i * 2] = p[0]
    start[i * 2 + 1] = p[1]
  }
  entities.forEach((e, k) => {
    const b = base[k]
    switch (e.kind) {
      case 'line':
        put(b, e.from)
        put(b + 1, e.to)
        break
      case 'circle':
        put(b, e.center)
        put(b + 1, [e.center[0] + e.radius, e.center[1]])
        break
      case 'arc':
        put(b, e.center)
        put(b + 1, [e.center[0] + e.radius * Math.cos(e.fromAngle), e.center[1] + e.radius * Math.sin(e.fromAngle)])
        put(b + 2, [e.center[0] + e.radius * Math.cos(e.toAngle), e.center[1] + e.radius * Math.sin(e.toAngle)])
        break
      case 'spline':
        e.points.forEach((p, i) => put(b + i, p))
        break
    }
  })
  return { start, pointCount: n, base }
}

/** The solved coordinates back into entities. */
export function applyDofs(entities: SketchEntity[], dofs: SketchDofs, values: PointDofs): SketchEntity[] {
  const at = (i: number): [number, number] => [values[i * 2], values[i * 2 + 1]]
  return entities.map((e, k) => {
    const b = dofs.base[k]
    switch (e.kind) {
      case 'line':
        return { kind: 'line', from: at(b), to: at(b + 1) }
      case 'circle': {
        const c = at(b)
        const p = at(b + 1)
        return { kind: 'circle', center: c, radius: Math.max(1e-4, Math.hypot(p[0] - c[0], p[1] - c[1])) }
      }
      case 'arc': {
        const c = at(b)
        const a = at(b + 1)
        const z = at(b + 2)
        const r = Math.max(1e-4, (Math.hypot(a[0] - c[0], a[1] - c[1]) + Math.hypot(z[0] - c[0], z[1] - c[1])) / 2)
        return { kind: 'arc', center: c, radius: r, fromAngle: Math.atan2(a[1] - c[1], a[0] - c[0]), toAngle: Math.atan2(z[1] - c[1], z[0] - c[0]) }
      }
      case 'spline':
        return { kind: 'spline', points: e.points.map((_, i) => at(b + i)), closed: e.closed }
    }
  })
}

/** A sketch's entities with its constraints settled: what a build pulls.
 *  `report` says how well they settled (a sketch can be over-constrained;
 *  the build pulls the best answer and the panel flags the residuals). */
export function solveEntities(entities: SketchEntity[], constraints: Constraint[]): { entities: SketchEntity[]; residual: number; unsatisfied: { kind: string; value: number }[] } {
  if (constraints.length === 0) return { entities, residual: 0, unsatisfied: [] }
  const dofs = sketchToDofs(entities)
  const { values, unsatisfied, residual } = solveSketch({ start: dofs.start, constraints, pointCount: dofs.pointCount })
  return { entities: applyDofs(entities, dofs, values), residual, unsatisfied }
}

// ---- Defaults ----------------------------------------------------------------

/** The feature factories the panel and the commands use: every number gets
 *  a sane millimetre default, the id is the caller's to assign. */
export const newBox = (id: number, name = ''): Feature => ({ id, kind: 'box', name: name || 'Box', width: 40, depth: 30, height: 20 })
export const newCylinder = (id: number, name = ''): Feature => ({ id, kind: 'cylinder', name: name || 'Cylinder', radius: 12, height: 30 })
export const newSphere = (id: number, name = ''): Feature => ({ id, kind: 'sphere', name: name || 'Sphere', radius: 15 })
export const newCone = (id: number, name = ''): Feature => ({ id, kind: 'cone', name: name || 'Cone', radius1: 15, radius2: 5, height: 30 })
export const newTorus = (id: number, name = ''): Feature => ({ id, kind: 'torus', name: name || 'Torus', majorRadius: 20, minorRadius: 5 })
export const newEllipsoid = (id: number, name = ''): Feature => ({ id, kind: 'ellipsoid', name: name || 'Ellipsoid', rx: 20, ry: 15, rz: 10 })
export const newSketch = (id: number, name = '', plane: DatumPlane = 'xy', entities: SketchEntity[] = []): Feature => ({ id, kind: 'sketch', name: name || 'Sketch', plane, on: 'datum', offset: 0, shift: [0, 0], entities, constraints: [] })
export const newExtrude = (id: number, name = '', sketch = 0, depth = 10): Feature => ({ id, kind: 'extrude', name: name || 'Extrude', sketch, depth })
export const newRevolve = (id: number, name = '', sketch = 0, angleDeg = 360, axis: 'x' | 'y' | 'z' = 'z'): Feature => ({ id, kind: 'revolve', name: name || 'Revolve', sketch, angleDeg, axis })
export const newLoft = (id: number, name = '', sketches: number[] = [], ruled = false): Feature => ({ id, kind: 'loft', name: name || 'Loft', sketches, ruled })
export const newBoolean = (id: number, name = '', op: BooleanOp = 'fuse', a = 0, b = 1): Feature => ({ id, kind: 'boolean', name: name || op.slice(0, 1).toUpperCase() + op.slice(1), op, a, b })
export const newFillet = (id: number, name = '', body = 0, radius = 3): Feature => ({ id, kind: 'fillet', name: name || 'Fillet', body, radius, edges: { which: 'all' } })
export const newChamfer = (id: number, name = '', body = 0, distance = 3): Feature => ({ id, kind: 'chamfer', name: name || 'Chamfer', body, distance, edges: { which: 'all' } })
export const newShell = (id: number, name = '', body = 0, thickness = 2): Feature => ({ id, kind: 'shell', name: name || 'Shell', body, thickness, open: { which: 'top' } })
export const newLinearPattern = (id: number, name = '', body = 0): Feature => ({ id, kind: 'linearPattern', name: name || 'Pattern', body, direction: [1, 0, 0], spacing: 20, count: 3 })
export const newCircularPattern = (id: number, name = '', body = 0): Feature => ({ id, kind: 'circularPattern', name: name || 'Circular pattern', body, center: [0, 0, 0], axis: 'z', angleDeg: 360, count: 6 })
export const newMirror = (id: number, name = '', body = 0, plane: DatumPlane = 'yz'): Feature => ({ id, kind: 'mirror', name: name || 'Mirror', body, plane })
export const newComponent = (id: number, name = '', body = 0): Feature => ({ id, kind: 'component', name: name || 'Component', body, placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] } })
