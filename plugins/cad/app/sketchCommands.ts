// SPDX-License-Identifier: AGPL-3.0-only
// The sketch as an agent edits it: the sheet's operations, named.
// `cad.sketch_get` reads a sketch back — its plane, its pieces, its
// points by solver index (the index every constraint names a point by),
// its constraints, and how the last build settled them.
// `cad.sketch_edit` performs the sheet's edits on a sketch in one step:
// add a line/circle/arc/rectangle, move a point (the constraints pull the
// rest along, as the sheet's drag solves), weld two points to one,
// constrain two pieces, delete a piece or a constraint, and infer what
// the drawing means. The edit goes through the same applyCad as every
// CAD command: one undo step, the build awaited, a failure leaves the
// list as it was. The sketch closed and welded is what cad.extrude
// pulls at its full depth — the panel path and the agent path are the
// same code (core/sketchEdit.ts).

import { type Command } from '../../../src/plugins/api'
import { arr, int, num, obj, oneOf, type JsonSchema } from '../../../src/commands/schema'
import { invalid } from '../../../src/commands/core/common'
import { applyCad } from './cadCommands'
import { useCad } from '../state/cadStore'
import { addConstraint, deleteEntity, guessConstraints, movePoint, rectangle, removeConstraint, sketchPoints, weldPoint, type SketchDoc } from '../core/sketchEdit'
import type { Constraint } from '../core/solver2d'
import type { SketchEntity } from '../core/types'
import type { Feature } from '../core/part'

const featureSchema = int('The feature: its place in the list (0, 1, …).')
const pt2 = (what: string): JsonSchema => arr(num(), what, { minItems: 2, maxItems: 2 })
const pair = (what: string): JsonSchema => arr(int(), what, { minItems: 2, maxItems: 2 })

/** A piece as the agent gives it: a line, a circle, an arc, a rectangle
 *  (four welded lines with the sides held to the axes). */
const entityIn: JsonSchema = oneOf([
  obj({ from: pt2('The line’s start [x, y].'), to: pt2('The line’s end [x, y].') }, ['from', 'to']),
  obj({ center: pt2('The circle’s centre [x, y].'), radius: num('Its radius, mm.', { exclusiveMinimum: 0 }) }, ['center', 'radius']),
  obj({ center: pt2('The arc’s centre [x, y].'), radius: num('Its radius, mm.', { exclusiveMinimum: 0 }), fromAngle: num('Where it starts, radians.'), toAngle: num('Where it ends, radians — the arc sweeps counter-clockwise from the start to here.') }, ['center', 'radius', 'fromAngle', 'toAngle']),
  obj({ rectangle: arr(num(), 'x, y, width, height — the rectangle centred on (x, y).', { minItems: 4, maxItems: 4 }) }, ['rectangle']),
])

/** A constraint as the agent gives it, over the solver's point indexes —
 *  a line's own two points are its index's pair, so a line's index
 *  (piece i, its first point) is what horizontal, vertical, parallel,
 *  perpendicular and equal name. */
const constraintIn: JsonSchema = oneOf([
  obj({ coincident: pair('The two points to weld to one.') }, ['coincident']),
  obj({ horizontal: int('The line whose endpoints share a y (its first point’s index).') }, ['horizontal']),
  obj({ vertical: int('The line whose endpoints share an x (its first point’s index).') }, ['vertical']),
  obj({ parallel: pair('The two lines to run the same way.') }, ['parallel']),
  obj({ perpendicular: pair('The two lines to set at right angles.') }, ['perpendicular']),
  obj({ equal: pair('The two lines to share a length.') }, ['equal']),
  obj({ pointOnLine: arr(int(), 'The point, the line’s start, the line’s end.', { minItems: 3, maxItems: 3 }) }, ['pointOnLine']),
  obj({ angle: arr(num(), 'Point a, point b, point c, the angle at a in radians.', { minItems: 4, maxItems: 4 }) }, ['angle']),
  obj({ distance: arr(num(), 'Point a, point b, the distance in mm.', { minItems: 3, maxItems: 3 }) }, ['distance']),
  obj({ fixed: int('The point to pin where it lies.') }, ['fixed']),
])

function constraintOf(c: Record<string, unknown>): Constraint | null {
  const numAt = (v: unknown, i: number): number => (Array.isArray(v) ? Number(v[i]) : NaN)
  if (c.coincident) return { kind: 'coincident', a: numAt(c.coincident, 0), b: numAt(c.coincident, 1) }
  if (typeof c.horizontal === 'number') return { kind: 'horizontal', a: c.horizontal, b: c.horizontal + 1 }
  if (typeof c.vertical === 'number') return { kind: 'vertical', a: c.vertical, b: c.vertical + 1 }
  if (c.parallel) return { kind: 'parallel', a1: numAt(c.parallel, 0), b1: numAt(c.parallel, 0) + 1, a2: numAt(c.parallel, 1), b2: numAt(c.parallel, 1) + 1 }
  if (c.perpendicular) return { kind: 'perpendicular', a1: numAt(c.perpendicular, 0), b1: numAt(c.perpendicular, 0) + 1, a2: numAt(c.perpendicular, 1), b2: numAt(c.perpendicular, 1) + 1 }
  if (c.equal) return { kind: 'equal-distance', a1: numAt(c.equal, 0), b1: numAt(c.equal, 0) + 1, a2: numAt(c.equal, 1), b2: numAt(c.equal, 1) + 1 }
  if (c.pointOnLine) return { kind: 'point-on-line', a: numAt(c.pointOnLine, 0), a2: numAt(c.pointOnLine, 1), b2: numAt(c.pointOnLine, 2) }
  if (c.angle) return { kind: 'angle', a: numAt(c.angle, 0), b: numAt(c.angle, 1), c: numAt(c.angle, 2), value: numAt(c.angle, 3) }
  if (c.distance) return { kind: 'distance', a: numAt(c.distance, 0), b: numAt(c.distance, 1), value: numAt(c.distance, 2) }
  if (typeof c.fixed === 'number') return { kind: 'fixed', a: c.fixed }
  return null
}

/** The sketch's shape, as the readout answers: pieces with their points
 *  by index, every point, the constraints, how the build settled it. */
function sketchOut(features: Feature[], at: number) {
  const f = features[at]
  if (f.kind !== 'sketch') return null
  const pts = sketchPoints(f.entities)
  const res = useCad.getState().results[at]
  return {
    index: at,
    id: f.id,
    name: f.name,
    plane: f.plane,
    on: f.on,
    offset: f.offset,
    shift: f.shift,
    entities: f.entities.map((e, i) => ({ i, ...e, points: pts.filter((p) => p.entity === i).map((p) => ({ index: p.index, slot: p.slot, at: p.at })) })),
    points: pts,
    constraints: f.constraints,
    built: res?.ok === true,
    ...(res && !res.ok ? { reason: res.reason } : {}),
  }
}

const sketchGet: Command<{ sketch: number }> = {
  name: 'sketch_get',
  title: 'Read a sketch',
  description:
    'A sketch as the sheet edits it: its plane, offset and shift; its pieces (lines, circles, arcs, a rectangle as four welded lines) each with its points; every point named by its solver index — the index every constraint names a point by — with its [x, y]; its constraints; and how the last build settled them (built, and why not if it failed). The readout cad.sketch_edit answers to, and the way to see what to weld, constrain, or move next. Changes nothing.',
  input: obj({ sketch: featureSchema }, ['sketch']),
  readOnly: true,
  run: async ({ sketch }) => {
    const at = useCad.getState().features.findIndex((f) => f.id === sketch)
    if (at < 0) invalid(`There is no feature ${sketch} on the part — cad.status tells what there is.`)
    const out = sketchOut(useCad.getState().features, at)
    if (!out) invalid(`Feature ${sketch} is a ${useCad.getState().features[at].kind}, not a sketch.`)
    return out
  },
}

interface SketchEditIn {
  sketch: number
  add?: Record<string, unknown>[]
  move?: { point: number; x: number; y: number }[]
  weld?: { point: number; onto: number }[]
  constrain?: Record<string, unknown>[]
  deleteEntities?: number[]
  deleteConstraints?: number[]
  infer?: boolean
}

const sketchEdit: Command<SketchEditIn> = {
  name: 'sketch_edit',
  title: 'Edit a sketch',
  description:
    'Edit one sketch on the CAD part the way the panel’s sheet does, in one step, and build the part: add pieces (add: lines {from,to}, circles {center,radius}, arcs {center,radius,fromAngle,toAngle}, rectangles {rectangle:[x,y,w,h]} — four welded lines held to the axes), move points by their solver index (move: {point,x,y} — the constraints pull the rest of the sketch along, as a drag on the sheet solves), weld a point onto a vertex (weld: {point,onto}), constrain pieces (constrain: coincident [a,b], horizontal/vertical <lineIndex>, parallel/perpendicular/equal [lineA,lineB], pointOnLine [point,lineStart,lineEnd], angle [a,b,c,rad], distance [a,b,mm], fixed <point>), delete pieces by index (deleteEntities) and constraints by their index in the list (deleteConstraints), and read the drawing back as constraints (infer: true — welded ends, axis-aligned sides, a start on the origin pinned). Answers the sketch as it stands after, cad.sketch_get’s shape. A sketch closed and welded at its corners is what cad.extrude pulls at its full depth; a sketch with gaps extrudes as a shell.',
  input: obj(
    {
      sketch: featureSchema,
      add: arr(entityIn, 'Pieces to add at the end, in order.', { minItems: 1 }),
      move: arr(obj({ point: int('The point’s solver index.'), x: num('Its new x, mm.'), y: num('Its new y, mm.') }, ['point', 'x', 'y']), 'Points to move, solved about the constraints.', { minItems: 1 }),
      weld: arr(obj({ point: int('The point to weld.'), onto: int('The vertex to weld it onto.') }, ['point', 'onto']), 'Points to weld onto vertices.', { minItems: 1 }),
      constrain: arr(constraintIn, 'Constraints to add, over point indexes.', { minItems: 1 }),
      deleteEntities: arr(int('The piece’s index.'), 'Pieces to delete, with the constraints naming their points.', { minItems: 1 }),
      deleteConstraints: arr(int('The constraint’s index in the list.'), 'Constraints to remove.', { minItems: 1 }),
      infer: { type: 'boolean', description: 'Read the drawing back as constraints, as the sheet’s Infer does.' },
    },
    ['sketch'],
  ),
  run: async (p) => {
    const st = useCad.getState()
    const at = st.features.findIndex((f) => f.id === p.sketch)
    if (at < 0) invalid(`There is no feature ${p.sketch} on the part — cad.status tells what there is.`)
    if (st.features[at].kind !== 'sketch') invalid(`Feature ${p.sketch} is a ${st.features[at].kind}, not a sketch.`)
    const notes: string[] = []
    await applyCad((features) => {
      const f = features[at]
      if (f.kind !== 'sketch') return null
      let doc: SketchDoc = { entities: structuredClone(f.entities), constraints: structuredClone(f.constraints) }
      for (const e of p.add ?? []) {
        if (Array.isArray((e as { from?: unknown }).from) && Array.isArray((e as { to?: unknown }).to)) {
          const v = e as unknown as { from: [number, number]; to: [number, number] }
          doc = { ...doc, entities: [...doc.entities, { kind: 'line', from: v.from, to: v.to } as SketchEntity] }
        } else if (Array.isArray((e as { center?: unknown }).center) && typeof (e as { radius?: unknown }).radius === 'number') {
          const v = e as unknown as { center: [number, number]; radius: number; fromAngle?: number; toAngle?: number }
          doc = {
            ...doc,
            entities: [...doc.entities, typeof v.fromAngle === 'number' && typeof v.toAngle === 'number' ? ({ kind: 'arc', center: v.center, radius: v.radius, fromAngle: v.fromAngle, toAngle: v.toAngle } as SketchEntity) : ({ kind: 'circle', center: v.center, radius: v.radius } as SketchEntity)],
          }
        } else if (Array.isArray((e as { rectangle?: unknown }).rectangle) && (e as { rectangle: number[] }).rectangle.length === 4) {
          const [x, y, w, h] = (e as unknown as { rectangle: [number, number, number, number] }).rectangle
          if (!(w > 0 && h > 0)) invalid('The rectangle’s width and height must stand over zero.')
          doc = rectangle(doc, x, y, w, h).doc
          notes.push('The rectangle came as four welded lines, the sides held to the axes.')
        } else invalid('A piece is a line {from,to}, a circle {center,radius}, an arc {center,radius,fromAngle,toAngle} or a rectangle {rectangle:[x,y,w,h]}.')
      }
      for (const m of p.move ?? []) {
        const pts = sketchPoints(doc.entities)
        if (!pts[m.point]) invalid(`The sketch has no point ${m.point} — it has ${pts.length}.`)
        const moved = movePoint(doc, m.point, [m.x, m.y])
        doc = moved.doc
        if (moved.residual > 1e-3) notes.push(`The solve settled ${moved.residual.toFixed(3)} mm off — a constraint fights the move.`)
      }
      for (const w of p.weld ?? []) {
        const pts = sketchPoints(doc.entities)
        if (!pts[w.point] || !pts[w.onto]) invalid(`weld names points ${w.point}→${w.onto}; the sketch has ${pts.length}.`)
        doc = weldPoint(doc, w.point, w.onto)
      }
      for (const c of p.constrain ?? []) {
        const con = constraintOf(c)
        if (con) doc = addConstraint(doc, con)
        else invalid('A constraint is coincident/horizontal/vertical/parallel/perpendicular/equal/pointOnLine/angle/distance/fixed, over point indexes.')
      }
      for (const i of [...(p.deleteEntities ?? [])].sort((a, b) => b - a)) {
        if (i < 0 || i >= doc.entities.length) invalid(`The sketch has no piece ${i} — it has ${doc.entities.length}.`)
        doc = deleteEntity(doc, i)
      }
      for (const i of [...(p.deleteConstraints ?? [])].sort((a, b) => b - a)) {
        if (i < 0 || i >= doc.constraints.length) invalid(`The sketch has no constraint ${i} — it has ${doc.constraints.length}.`)
        doc = removeConstraint(doc, i)
      }
      if (p.infer) {
        const g = guessConstraints(doc)
        doc = g.doc
        if (g.added.length) notes.push(`Infer added ${g.added.length} constraint(s): ${[...new Set(g.added)].join(', ')}.`)
      }
      features[at] = { ...f, entities: doc.entities, constraints: doc.constraints }
      return features
    })
    const sketch = sketchOut(useCad.getState().features, at)
    return { ...(sketch as NonNullable<typeof sketch>), ...(notes.length ? { notes } : {}) }
  },
}

export const sketchCommands = [sketchGet, sketchEdit].map((c) => ({ ...c, headless: true })) as Command<never>[]
