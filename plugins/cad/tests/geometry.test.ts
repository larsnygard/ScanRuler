// SPDX-License-Identifier: AGPL-3.0-only
// The pure geometry: the planes a part stands in, the sketch's loops and
// their nesting, and the constraint solver settling a sketch. No kernel,
// no DOM — plain numbers in, plain numbers out.

import { describe, expect, it } from 'vitest'
import { DATUM_PLANES, apply, compose, extrudeVector, fromEuler, rotationAbout, sketchPlane, toEuler, toPart, toSketch, yOf } from '../core/frame'
import { closeLoops, islandsOf, polylineArea, sketchArea } from '../core/sketch2d'
import type { Constraint, PointDofs } from '../core/solver2d'
import { residualOf, solveSketch } from '../core/solver2d'
import type { SketchEntity } from '../core/types'

describe('the frames', () => {
  it('the datum planes are right-handed frames', () => {
    for (const [, p] of Object.entries(DATUM_PLANES)) {
      const y = yOf(p)
      // y = z × x and the frame is right-handed: x × y = z.
      const cross = [p.xAxis[1] * y[2] - p.xAxis[2] * y[1], p.xAxis[2] * y[0] - p.xAxis[0] * y[2], p.xAxis[0] * y[1] - p.xAxis[1] * y[0]]
      expect(cross[0]).toBeCloseTo(p.zAxis[0])
      expect(cross[1]).toBeCloseTo(p.zAxis[1])
      expect(cross[2]).toBeCloseTo(p.zAxis[2])
      // The axes are unit and at right angles.
      for (const a of [p.xAxis, y, p.zAxis]) {
        expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1)
      }
      expect(p.xAxis[0] * y[0] + p.xAxis[1] * y[1] + p.xAxis[2] * y[2]).toBeCloseTo(0)
    }
  })

  it('a sketch round-trips a point through the plane and back', () => {
    for (const p of Object.values(DATUM_PLANES)) {
      const at: [number, number] = [3, -7]
      const back = toSketch(p, toPart(p, at))
      expect(back[0]).toBeCloseTo(3)
      expect(back[1]).toBeCloseTo(-7)
    }
  })

  it('a sketch plane sits at the box top, pushed and shifted by hand', () => {
    const box = { min: [-5, -10, 0] as [number, number, number], max: [5, 10, 30] as [number, number, number] }
    const p = sketchPlane('xy', box, 0)
    expect(p.origin[2]).toBeCloseTo(30)
    const q = sketchPlane('xy', null, 12, [2, 3])
    expect(q.origin[2]).toBeCloseTo(12)
    expect(q.origin[0]).toBeCloseTo(2)
    expect(q.origin[1]).toBeCloseTo(3)
  })

  it('the extrude runs along the plane normal, negative cutting back', () => {
    const up = extrudeVector(DATUM_PLANES.xy, 8)
    const down = extrudeVector(DATUM_PLANES.xy, -5)
    for (const [i, v] of up.entries()) {
      expect(v).toBeCloseTo([0, 0, 8][i])
      expect(down[i]).toBeCloseTo([0, 0, -5][i])
    }
  })

  it('a turn about Z carries X to Y, and placements compose', () => {
    const r = rotationAbout([0, 0, 1], Math.PI / 2)
    const p = apply({ rotation: r, translation: [0, 0, 0] }, [1, 0, 0])
    expect(p[0]).toBeCloseTo(0)
    expect(p[1]).toBeCloseTo(1)
    expect(p[2]).toBeCloseTo(0)
    // compose(a, b): a's frame first, b read within it — a placement put
    // on top of a placement, how a pattern repeats a component.
    const a = { rotation: r, translation: [10, 0, 0] as [number, number, number] }
    const b = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 4, 0] as [number, number, number] }
    const ab = compose(a, b)
    const q = apply(ab, [1, 0, 0])
    expect(q[0]).toBeCloseTo(6)
    expect(q[1]).toBeCloseTo(1)
    expect(q[2]).toBeCloseTo(0)
  })

  it('Euler angles round-trip', () => {
    const e: [number, number, number] = [0.3, -0.8, 1.9]
    const m = fromEuler(...e)
    const back = toEuler(m)
    expect(back[0]).toBeCloseTo(e[0])
    expect(back[1]).toBeCloseTo(e[1])
    expect(back[2]).toBeCloseTo(e[2])
  })
})

describe('the sketch loops', () => {
  it('signed area: counter-clockwise is positive', () => {
    expect(polylineArea([[0, 0], [4, 0], [4, 4], [0, 4]])).toBeCloseTo(16)
    expect(polylineArea([[0, 0], [0, 4], [4, 4], [4, 0]])).toBeCloseTo(-16)
  })

  it('open lines close into a loop', () => {
    const ents: SketchEntity[] = [
      { kind: 'line', from: [0, 0], to: [10, 0] },
      { kind: 'line', from: [10, 0], to: [10, 6] },
      { kind: 'line', from: [10, 6], to: [0, 6] },
      { kind: 'line', from: [0, 6], to: [0, 0] },
    ]
    const loops = closeLoops(ents)
    expect(loops.length).toBe(1)
    expect(Math.abs(loops[0].area)).toBeCloseTo(60)
  })

  it('a shape with an arc welds the arc between its lines', () => {
    // A square with one side bowed out as a semicircular arc, centre at
    // (10,5), from (10,0) over (15,5) to (10,10).
    const ents: SketchEntity[] = [
      { kind: 'line', from: [0, 0], to: [10, 0] },
      { kind: 'arc', center: [10, 5], radius: 5, fromAngle: -Math.PI / 2, toAngle: Math.PI / 2 },
      { kind: 'line', from: [10, 10], to: [0, 10] },
      { kind: 'line', from: [0, 10], to: [0, 0] },
    ]
    const loops = closeLoops(ents)
    expect(loops.length).toBe(1)
    // The square's 100 with the half-disc of r=5 bowed out: 100 + π·25/2.
    expect(Math.abs(loops[0].area)).toBeCloseTo(100 + (Math.PI * 25) / 2, 0)
  })

  it('nested loops sort into an island with its hole, and the island inside the hole', () => {
    const ents: SketchEntity[] = [
      { kind: 'line', from: [-10, -10], to: [10, -10] },
      { kind: 'line', from: [10, -10], to: [10, 10] },
      { kind: 'line', from: [10, 10], to: [-10, 10] },
      { kind: 'line', from: [-10, 10], to: [-10, -10] },
      { kind: 'circle', center: [0, 0], radius: 6 },
      { kind: 'circle', center: [0, 0], radius: 2 },
    ]
    const islands = islandsOf(closeLoops(ents))
    expect(islands.length).toBe(2)
    const big = islands.find((i) => i.outline.area > 300)!
    expect(big.holes.length).toBe(1)
    expect(Math.abs(big.holes[0].area)).toBeCloseTo(Math.PI * 36)
    const small = islands.find((i) => i.outline.area < 300)!
    expect(Math.abs(small.outline.area)).toBeCloseTo(Math.PI * 4)
  })

  it('two separate outlines stand as two islands', () => {
    const ents: SketchEntity[] = [
      { kind: 'circle', center: [-20, 0], radius: 3 },
      { kind: 'circle', center: [20, 0], radius: 4 },
    ]
    const islands = islandsOf(closeLoops(ents))
    expect(islands.length).toBe(2)
    expect(islands.every((i) => i.holes.length === 0)).toBe(true)
  })

  it('an open chain of lines that never closes gives no loop', () => {
    const ents: SketchEntity[] = [
      { kind: 'line', from: [0, 0], to: [5, 0] },
      { kind: 'line', from: [5, 0], to: [10, 5] },
    ]
    expect(closeLoops(ents).length).toBe(0)
  })

  it('the area a sketch encloses counts outlines minus holes', () => {
    const ents: SketchEntity[] = [
      { kind: 'line', from: [-10, -10], to: [10, -10] },
      { kind: 'line', from: [10, -10], to: [10, 10] },
      { kind: 'line', from: [10, 10], to: [-10, 10] },
      { kind: 'line', from: [-10, 10], to: [-10, -10] },
      { kind: 'circle', center: [0, 0], radius: 4 },
    ]
    expect(sketchArea(ents)).toBeCloseTo(400 - Math.PI * 16, 0)
  })
})

describe('the constraint solver', () => {
  const run = (start: PointDofs, constraints: Constraint[], pointCount: number) => solveSketch({ start, constraints, pointCount })

  it('a fixed point does not move when a distance pulls it', () => {
    const { values, residual } = run(new Float64Array([0, 0, 10, 0]), [{ kind: 'fixed', a: 0 }, { kind: 'distance', a: 0, b: 1, value: 5 }], 2)
    expect(residual).toBeLessThan(1e-6)
    expect(values[0]).toBeCloseTo(0)
    expect(values[1]).toBeCloseTo(0)
    expect(Math.hypot(values[2], values[3])).toBeCloseTo(5, 6)
  })

  it('a horizontal drags the far point level with the near one', () => {
    const { values, residual } = run(new Float64Array([0, 0, 4, 3]), [{ kind: 'horizontal', a: 0, b: 1 }], 2)
    expect(residual).toBeLessThan(1e-6)
    expect(values[1]).toBeCloseTo(values[3], 6)
  })

  it('a distance moves both points when neither is fixed', () => {
    const { values, residual } = run(new Float64Array([0, 0, 10, 0]), [{ kind: 'distance', a: 0, b: 1, value: 4 }], 2)
    expect(residual).toBeLessThan(1e-6)
    expect(Math.hypot(values[2] - values[0], values[3] - values[1])).toBeCloseTo(4, 6)
  })

  it('a square fully constrained settles from a drifting one', () => {
    // A 10×10 square whose sketch started at corners drifted from 9×11.
    const start = new Float64Array([0, 0, 9, 0.4, 11, 11, -0.3, 10.5])
    const { values, residual } = run(start, [
      { kind: 'fixed', a: 0 },
      { kind: 'horizontal', a: 0, b: 1 },
      { kind: 'vertical', a: 1, b: 2 },
      { kind: 'horizontal', a: 3, b: 2 },
      { kind: 'vertical', a: 0, b: 3 },
      { kind: 'distance', a: 0, b: 1, value: 10 },
      { kind: 'distance', a: 1, b: 2, value: 10 },
    ], 4)
    expect(residual).toBeLessThan(1e-6)
    expect(values[1]).toBeCloseTo(0, 5)
    expect(values[2]).toBeCloseTo(10, 5)
    expect(values[3]).toBeCloseTo(0, 5)
    expect(values[4]).toBeCloseTo(10, 5)
    expect(values[5]).toBeCloseTo(10, 5)
    expect(values[6]).toBeCloseTo(0, 5)
    expect(values[7]).toBeCloseTo(10, 5)
  })

  it('an equal-distance pair shortens the long line to the short one', () => {
    const { values, residual } = run(
      new Float64Array([0, 0, 3, 0, 10, 10, 10, 14]),
      [
        { kind: 'fixed', a: 0 },
        { kind: 'fixed', a: 1 },
        { kind: 'fixed', a: 2 },
        { kind: 'equal-distance', a1: 0, b1: 1, a2: 2, b2: 3 },
      ],
      4,
    )
    expect(residual).toBeLessThan(1e-6)
    expect(Math.hypot(values[2] - values[0], values[3] - values[1])).toBeCloseTo(3, 5)
    expect(Math.hypot(values[6] - values[4], values[7] - values[5])).toBeCloseTo(3, 5)
  })

  it('a symmetric-y pair mirrors its points about the Y axis', () => {
    // The pair floats (no pin) — the solver settles it onto the axis.
    const { values, residual } = run(new Float64Array([4, 1, -3, 2]), [{ kind: 'symmetric-y', a: 0, b: 1 }], 2)
    // The LM damping leaves ~1e-6 of residual; at 1e-4 mm the sketch is
    // as good as solved.
    expect(residual).toBeLessThan(1e-4)
    expect(values[0]).toBeCloseTo(-values[2], 4)
    expect(values[1]).toBeCloseTo(values[3], 4)
  })

  it('an origin-distance sets the distance from the sketch origin', () => {
    const { values, residual } = run(new Float64Array([0, 0, 4, 0]), [{ kind: 'origin-distance', a: 1, value: 7 }], 2)
    expect(residual).toBeLessThan(1e-6)
    expect(Math.hypot(values[2], values[3])).toBeCloseTo(7, 5)
  })

  it('a point pinned to the X axis loses its height', () => {
    const { values, residual } = run(new Float64Array([2, 5]), [{ kind: 'on-x-axis', a: 0 }], 1)
    expect(residual).toBeLessThan(1e-6)
    expect(values[1]).toBeCloseTo(0, 5)
    expect(values[0]).toBeCloseTo(2, 5)
  })

  it('a parallel pair stands parallel and a perpendicular pair at right angles', () => {
    const { values, residual } = run(
      new Float64Array([0, 0, 4, 0, 0, 3, 4, 0.4]),
      [
        { kind: 'fixed', a: 0 },
        { kind: 'fixed', a: 1 },
        { kind: 'fixed', a: 2 },
        { kind: 'parallel', a1: 0, b1: 1, a2: 2, b2: 3 },
      ],
      4,
    )
    expect(residual).toBeLessThan(1e-4)
    // A parallel segment shares its direction, not its y: p2→p3 lies
    // level, at its own height.
    expect(values[5]).toBeCloseTo(values[7], 4)
    const { values: w, residual: res2 } = run(
      new Float64Array([0, 0, 4, 0, 2, -1, 2, 3]),
      [
        { kind: 'fixed', a: 0 },
        { kind: 'fixed', a: 1 },
        { kind: 'fixed', a: 2 },
        { kind: 'perpendicular', a1: 0, b1: 1, a2: 2, b2: 3 },
      ],
      4,
    )
    expect(res2).toBeCloseTo(0, 4)
    // Perpendicular to the x-axis segment: p2→p3 stands plumb, sharing x.
    expect(w[4]).toBeCloseTo(w[6], 4)
  })

  it('a contradiction names itself in the residuals', () => {
    const { unsatisfied, residual } = run(new Float64Array([0, 0, 10, 0]), [
      { kind: 'fixed', a: 0 },
      { kind: 'fixed', a: 1 },
      { kind: 'distance', a: 0, b: 1, value: 5 },
    ], 2)
    expect(residual).toBeGreaterThan(1)
    expect(unsatisfied[0].kind).toBe('distance')
  })

  it('the over-constrained flag warns when the equations outnumber the free DOF', () => {
    // One end pinned leaves two free DOF; three rows on the segment make
    // it over: horizontal, vertical, and 5 long — a pin, which is not a
    // row, does not count toward the equations.
    const { overConstrained, residual } = run(new Float64Array([0, 0, 10, 0]), [
      { kind: 'fixed', a: 0 },
      { kind: 'horizontal', a: 0, b: 1 },
      { kind: 'vertical', a: 0, b: 1 },
      { kind: 'distance', a: 0, b: 1, value: 5 },
      { kind: 'on-x-axis', a: 1 },
    ], 2)
    expect(overConstrained).toBe(true)
    expect(residual).toBeGreaterThan(0)
  })

  it('the solve leaves the start array untouched', () => {
    const start = new Float64Array([0, 0, 10, 0])
    const before = Array.from(start)
    solveSketch({ start, constraints: [{ kind: 'distance', a: 0, b: 1, value: 5 }], pointCount: 2 })
    expect(Array.from(start)).toEqual(before)
  })

  it('no constraints keep the points as drawn', () => {
    const { values, residual } = run(new Float64Array([1, 2, 3, 4]), [], 2)
    expect(residual).toBe(0)
    expect(Array.from(values)).toEqual([1, 2, 3, 4])
  })

  it('a residual of a satisfied constraint is zero', () => {
    const v = new Float64Array([0, 0, 3, 4])
    expect(residualOf({ kind: 'distance', a: 0, b: 1, value: 5 }, v)).toBeCloseTo(0)
    expect(residualOf({ kind: 'distance', a: 0, b: 1, value: 3 }, v)).toBeCloseTo(2)
  })

  it('a 40-point chain settles quickly and exactly', () => {
    // A 40-vertex closed polygon: each vertex welded to its neighbour
    // (coincident pairs of a shared sketch) and one fixed. Build it as a
    // 40-point square spiral, pin the first vertex, and check the solver
    // runs under 50 ms and keeps the pin.
    const pts = new Float64Array(80)
    let x = 0,
      y = 0
    for (let i = 0; i < 40; i++) {
      pts[i * 2] = x
      pts[i * 2 + 1] = y
      x += i % 2 === 0 ? 5 : 0
      y += i % 2 === 1 ? 5 : 0
    }
    const t0 = performance.now()
    const { values, residual } = solveSketch({ start: pts, constraints: [{ kind: 'fixed', a: 0 }, { kind: 'origin-distance', a: 5, value: 20 }], pointCount: 40 })
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(values[0]).toBeCloseTo(0)
    expect(values[1]).toBeCloseTo(0)
    expect(Math.hypot(values[10], values[11])).toBeCloseTo(20, 4)
    expect(residual).toBeLessThan(1e-4)
  })
})
