// SPDX-License-Identifier: AGPL-3.0-only
// The sketch as it is edited: the points every constraint names, a drag
// solved about the constraints, two points welded to one, pieces and
// constraints added and removed, the drawing read back as constraints.
// These are the operations of the sheet (ui/SketchSheet.tsx) and of the
// agent's cad.sketch_edit — the same core, run here plain, no kernel.

import { describe, expect, it } from 'vitest'
import { addConstraint, deleteEntity, dist2, dofsOf, guessConstraints, movePoint, nearestVertex, rectangle, removeConstraint, setPoint, sketchPoints, weldPoint, type SketchDoc } from '../core/sketchEdit'
import { solveSketch } from '../core/solver2d'
import type { Constraint } from '../core/solver2d'
import type { SketchEntity } from '../core/types'

const line = (x1: number, y1: number, x2: number, y2: number): SketchEntity => ({ kind: 'line', from: [x1, y1], to: [x2, y2] })

/** Settle a doc as the solver does: its points and the report. */
function settled(doc: SketchDoc) {
  const pts = sketchPoints(doc.entities)
  const { start, pointCount } = dofsOf(doc)
  const rep = solveSketch({ start, constraints: doc.constraints, pointCount })
  return { pts, rep }
}

/** A square centred on the origin, 10×10: four welded lines with the
 *  sides held to the axes — the rectangle tool's result. */
function square(): SketchDoc {
  return rectangle({ entities: [], constraints: [] }, 0, 0, 10, 10).doc
}

describe('sketchPoints — the points every constraint names', () => {
  it('numbers them in the order the pieces ask for, with their slots', () => {
    const doc: SketchDoc = { entities: [line(0, 0, 10, 0), { kind: 'circle', center: [5, 5], radius: 2 }], constraints: [] }
    const pts = sketchPoints(doc.entities)
    expect(pts.length).toBe(4)
    expect(pts[0]).toMatchObject({ index: 0, entity: 0, slot: 0, at: [0, 0] })
    expect(pts[1]).toMatchObject({ index: 1, entity: 0, slot: 1, at: [10, 0] })
    expect(pts[2]).toMatchObject({ index: 2, entity: 1, slot: 0, at: [5, 5] })
    // The circle's radius handle sits on the rim, at (center.x + r, y).
    expect(pts[3]).toMatchObject({ index: 3, entity: 1, slot: 1, at: [7, 5] })
  })
})

describe('the rectangle verb', () => {
  it('makes four welded axis-held lines whose corners meet', () => {
    const doc = square()
    expect(doc.entities.length).toBe(4)
    expect(doc.constraints.length).toBe(8)
    const { pts, rep } = settled(doc)
    expect(rep.residual).toBeLessThan(1e-6)
    // Its sides lie on x=±5, y=±3 for a 10×6; here it is a 10×10 square.
    expect(Math.max(...pts.map((p) => p.at[0]))).toBeCloseTo(5, 6)
    expect(Math.min(...pts.map((p) => p.at[1]))).toBeCloseTo(-5, 6)
  })
})

describe('a drag on a point', () => {
  it('moves it and solves the sketch about its constraints', () => {
    const doc = square()
    // The sheet's drag: the top-right corner (index 3) to (12, 8). The
    // corner welds carry the neighbours; the axis constraints hold the
    // rest standing.
    const moved = movePoint(doc, 3, [12, 8])
    const pts = sketchPoints(moved.doc.entities)
    expect(pts[3].at[0]).toBeCloseTo(12, 3)
    expect(pts[3].at[1]).toBeCloseTo(8, 3)
    // The dragged point stays put through the solve (movePoint pins it).
    expect(moved.residual).toBeLessThan(1e-2)
  })

  it('does not move a point a `fixed` constraint pins', () => {
    let doc = square()
    doc = addConstraint(doc, { kind: 'fixed', a: 3 })
    const moved = movePoint(doc, 3, [12, 8])
    const pts = sketchPoints(moved.doc.entities)
    expect(pts[3].at).toEqual([5, 5])
    expect(moved.residual).toBe(0)
  })

  it('moves a circle’s rim by its radius handle, not by a point', () => {
    const doc: SketchDoc = { entities: [{ kind: 'circle', center: [0, 0], radius: 5 }], constraints: [] }
    const moved = movePoint(doc, 1, [10, 0])
    const e = moved.doc.entities[0]
    expect(e.kind).toBe('circle')
    if (e.kind === 'circle') expect(e.radius).toBeCloseTo(10, 4)
  })
})

describe('welding', () => {
  it('welds a point onto a vertex and the solve keeps them one', () => {
    const doc: SketchDoc = { entities: [line(0, 0, 10, 0), line(20, 0, 20, 10)], constraints: [] }
    // The free line's start (index 2) welded onto the first line's end (1).
    const w = weldPoint(doc, 2, 1)
    expect(w.constraints).toEqual([{ kind: 'coincident', a: 2, b: 1 }])
    // The weld lands it right away.
    expect(sketchPoints(w.entities)[2].at).toEqual([10, 0])
    const { rep } = settled(w)
    expect(rep.residual).toBeLessThan(1e-6)
  })
})

describe('snapping to an existing vertex', () => {
  it('finds the nearest vertex within the tolerance, not beyond it', () => {
    const doc = square()
    expect(nearestVertex(doc.entities, [5.2, 5.2], 0.5)?.index).toBe(3)
    expect(nearestVertex(doc.entities, [6.2, 5.2], 0.5)).toBeNull()
  })
})

describe('constraints added and removed', () => {
  it('adds one over the points it names', () => {
    const doc = square()
    const c: Constraint = { kind: 'distance', a: 0, b: 1, value: 12 }
    expect(addConstraint(doc, c).constraints).toContainEqual(c)
  })

  it('removes one, one shorter', () => {
    const doc = square()
    expect(removeConstraint(doc, 0).constraints.length).toBe(doc.constraints.length - 1)
  })
})

describe('deleting a piece', () => {
  it('takes the constraints naming its points with it', () => {
    let doc = square()
    doc = addConstraint(doc, { kind: 'distance', a: 0, b: 1, value: 12 })
    const out = deleteEntity(doc, 0)
    expect(out.entities.length).toBe(3)
    // The distance named the deleted line's points (0 and 1): gone with it.
    expect(out.constraints.some((c) => c.kind === 'distance')).toBe(false)
  })
})

describe('reading the drawing back as constraints (Infer)', () => {
  it('infers the welds, the axes, and a start on the origin', () => {
    // Drawn free: a square whose corners land on each other and whose
    // start sits on the origin, with no constraints at all.
    const doc: SketchDoc = {
      entities: [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)],
      constraints: [],
    }
    const g = guessConstraints(doc)
    expect(g.added.length).toBeGreaterThan(4)
    expect(g.doc.constraints.filter((c) => c.kind === 'coincident').length).toBe(4)
    expect(g.doc.constraints.filter((c) => c.kind === 'horizontal').length).toBe(2)
    expect(g.doc.constraints.filter((c) => c.kind === 'vertical').length).toBe(2)
    expect(g.doc.constraints.some((c) => c.kind === 'fixed')).toBe(true)
  })

  it('is idempotent: reading a constrained rectangle back adds nothing', () => {
    const doc = square()
    const g = guessConstraints(doc)
    // The welds it names (low,high) are the rectangle's own (high,low);
    // the axes it names are its own. Infer runs, sees them, adds nothing.
    expect(g.added.length).toBe(0)
    expect(g.doc.constraints.length).toBe(doc.constraints.length)
    expect(guessConstraints(g.doc).added.length).toBe(0)
  })
})

describe('dist2 and setPoint on the sketch’s tuples', () => {
  it('measures two [x, y] points', () => {
    expect(dist2([0, 0], [3, 4])).toBeCloseTo(5, 9)
  })

  it('sets a point’s coordinates in place, no solve', () => {
    const doc = square()
    const moved = setPoint(doc.entities, 3, [1, 2])
    expect(sketchPoints(moved)[3].at).toEqual([1, 2])
  })
})
