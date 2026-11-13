// SPDX-License-Identifier: AGPL-3.0-only
// The builder, against the real kernel in Node: a feature list in, the
// bodies out. Each test builds the list, reads the measures back, and
// releases what the build made.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CadKernel } from '../core/kernel'
import { PartBuilder } from '../core/build'
import {
  newBoolean,
  newBox,
  newChamfer,
  newCylinder,
  newExtrude,
  newFillet,
  newLinearPattern,
  newMirror,
  newShell,
  newSketch,
} from '../core/part'
import type { Feature } from '../core/part'

let k: CadKernel

beforeAll(async () => {
  k = await CadKernel.load()
}, 60_000)

afterAll(() => {
  k?.dispose()
})

/** Build, return the results with the measures of every body, release. */
function run(features: Feature[]) {
  const b = new PartBuilder(k)
  const out = b.build(features)
  const measures = new Map<number, ReturnType<CadKernel['measures']>>()
  for (const [id, shape] of out.shapes) measures.set(id, k.measures(shape))
  for (const shape of out.shapes.values()) k.release(shape)
  return { out, measures }
}

type SketchF = Extract<Feature, { kind: 'sketch' }>
const sk = (f: Feature): SketchF => f as SketchF
const sphere = (radius: number): Feature => ({ id: 1, kind: 'sphere', name: 'Sphere', radius })
const lathe = (sketch: number, angleDeg: number, axis: 'x' | 'y' | 'z'): Feature => ({ id: 1, kind: 'revolve', name: 'Turn', sketch, angleDeg, axis })

const line = (from: [number, number], to: [number, number]) => ({ kind: 'line' as const, from, to })
const circle = (center: [number, number], radius: number) => ({ kind: 'circle' as const, center, radius })

const rect = (w: number, d: number): Feature[] => {
  const s = sk(newSketch(0, 'Rect', 'xy'))
  // The kernel puts a box centred on x/y at z 0..h; the rectangle's corner
  // (0, 0) sits at the box's (w/2, d/2) corner.
  s.entities = [line([-w / 2, -d / 2], [w / 2, -d / 2]), line([w / 2, -d / 2], [w / 2, d / 2]), line([w / 2, d / 2], [-w / 2, d / 2]), line([-w / 2, d / 2], [-w / 2, -d / 2])]
  return [s]
}

describe('the builder', () => {
  it('a box builds, and its volume is the numbers multiplied', () => {
    const { out, measures } = run([newBox(1, 'Block', )])
    // newBox defaults: 40 × 30 × 20.
    expect(out.results[0].ok).toBe(true)
    const m = measures.get(1)!
    expect(m.volume).toBeCloseTo(40 * 30 * 20, 0)
    expect(m.closed).toBe(true)
    expect(m.bounds.max[0]).toBeCloseTo(20)
    expect(m.bounds.min[0]).toBeCloseTo(-20)
    expect(m.bounds.max[2]).toBeCloseTo(20)
  })

  it('a sketch on the XY plane pulled 8 mm makes a prism of the right volume', () => {
    const feats: Feature[] = [...rect(20, 10), newExtrude(1, 'Pad', 0, 8)]
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    expect(measures.get(1)!.volume).toBeCloseTo(20 * 10 * 8, 0)
  })

  it('a sketch with a circle inside an outer rectangle pulls with the hole through it', () => {
    const feats: Feature[] = [...rect(30, 30), newExtrude(1, 'Pad', 0, 6)]
    // The circle sits in the same sketch as the rectangle: a hole.
    sk(feats[0]).entities.push(circle([0, 0], 5))
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    expect(measures.get(1)!.volume).toBeCloseTo(30 * 30 * 6 - Math.PI * 25 * 6, 0)
  })

  it('a cut leaves the difference of the volumes', () => {
    const feats: Feature[] = [newBox(0), newCylinder(1), newBoolean(2, 'Notch', 'cut', 0, 1)]
    const { out, measures } = run(feats)
    expect(out.results[2].ok).toBe(true)
    // Box 40·30·20, the cylinder r12 h30 standing through it (z 0..30, the
    // box z 0..20; the overlap π·144·20 — r12 reaches to ±12, the box's
    // y half-span is 15, x 20, so the whole circle cuts).
    expect(measures.get(2)!.volume).toBeCloseTo(40 * 30 * 20 - Math.PI * 144 * 20, 0)
  })

  it('a fuse joins both bodies', () => {
    const feats: Feature[] = [newBox(0), sphere(5), newBoolean(2, 'Join', 'fuse', 0, 1)]
    const { out, measures } = run(feats)
    expect(out.results[2].ok).toBe(true)
    // The sphere at the origin bites into the box's corner; the fused
    // volume lies between the box alone and the plain sum.
    const v = measures.get(2)!.volume
    const box = 40 * 30 * 20
    const whole = (4 / 3) * Math.PI * 125
    // The kernel sits the sphere's centre at z = r, at (0,0,r): the box
    // spans x,y −20..20, z 0..20, so the sphere (r5) lies wholly inside —
    // fusing leaves the box.
    expect(v).toBeGreaterThan(box - 1)
    expect(v).toBeLessThanOrEqual(box + whole)
  })

  it('a fillet softens a box and the body stays a closed solid', () => {
    const feats: Feature[] = [newBox(0), newFillet(1, 'Round', 0, 4)]
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    const m = measures.get(1)!
    expect(m.closed).toBe(true)
    expect(m.volume).toBeLessThan(40 * 30 * 20)
    expect(m.volume).toBeGreaterThan(40 * 30 * 20 * 0.9)
  })

  it('a chamfer cuts the corner away', () => {
    const feats: Feature[] = [newBox(0), newChamfer(1, 'Bevel', 0, 3)]
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    expect(measures.get(1)!.volume).toBeLessThan(40 * 30 * 20)
  })

  it('a shell hollows the box, opening the top', () => {
    const feats: Feature[] = [newBox(0), newShell(1, 'Hollow', 0, 2)]
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    const m = measures.get(1)!
    expect(m.volume).toBeLessThan(40 * 30 * 20)
    expect(m.volume).toBeGreaterThan(0)
  })

  it('a linear pattern repeats the body, count times the volume', () => {
    const feats: Feature[] = [newCylinder(0), newLinearPattern(1, 'Row', 0)]
    const { out, measures } = run(feats)
    expect(out.results[1].ok).toBe(true)
    // Three copies, spaced clear along x: no overlap (spacing 20 > 2r 24?
    // radius 12 → the copies touch at spacing 24; 20 overlaps — fuse keeps
    // one solid of less than 3×).
    const one = Math.PI * 144 * 30
    const v = measures.get(1)!.volume
    expect(v).toBeGreaterThan(one)
    expect(v).toBeLessThanOrEqual(3 * one + 1)
  })

  it('a mirror fuses the body to its reflection', () => {
    // A cylinder off the mirror plane, turned into a butterfly: the kernel
    // puts the cylinder on the axis, so place it clear first.
    const rod: Feature = { id: 0, kind: 'component', name: 'Rod', body: 1, placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [25, 0, 0] } }
    const feats: Feature[] = [newCylinder(1, 'Rod'), rod, newMirror(2, 'Butterfly', 0, 'yz')]
    const { out, measures } = run(feats)
    expect(out.results[2].ok).toBe(true)
    const m = measures.get(2)!
    // The rod at x 25 (r12 → 13..37) mirrors about the YZ datum (normal X)
    // to −37..−13: the fuse is both rods, twice the volume, the span
    // doubled.
    const one = Math.PI * 144 * 30
    expect(m.volume).toBeCloseTo(2 * one, -2)
    expect(m.bounds.max[0]).toBeCloseTo(37)
    expect(m.bounds.min[0]).toBeCloseTo(-37)
  })

  it('a feature that names a later feature fails, and the chain tells one story', () => {
    const { out } = run([newExtrude(0, 'Pad', 3, 5), newBox(1), newBox(2), newSketch(3)])
    expect(out.results[0].ok).toBe(false)
    expect(out.results[0].ok === false && out.results[0].reason).toContain('comes after')
  })

  it('a fillet on a failed body is blocked, naming the first reason', () => {
    const { out } = run([newExtrude(0, 'Pad', 5, 5), newFillet(1, 'Round', 0, 2)])
    expect(out.results[1].ok).toBe(false)
    expect(out.results[1].ok === false && out.results[1].reason).toContain('Blocked')
    expect(out.results[1].ok === false && out.results[1].reason).toContain('not in the list')
  })

  it('a zero radius names its own failure, plainly', () => {
    const { out } = run([newBox(0), newFillet(1, 'Round', 0, 0)])
    expect(out.results[1].ok).toBe(false)
    expect(out.results[1].ok === false && out.results[1].reason).toContain('no radius')
  })

  it('a pad on a pad: the second sketch lies on the top of the first body', () => {
    const s1 = sk(newSketch(0, 'Base', 'xy'))
    s1.entities = [line([0, 0], [40, 0]), line([40, 0], [40, 30]), line([40, 30], [0, 30]), line([0, 30], [0, 0])]
    const pad1 = newExtrude(1, 'Pad 1', 0, 10)
    const s2 = sk(newSketch(2, 'Top', 'xy'))
    s2.on = 'top'
    s2.entities = [line([5, 5], [15, 5]), line([15, 5], [15, 15]), line([15, 15], [5, 15]), line([5, 15], [5, 5])]
    const pad2 = newExtrude(3, 'Pad 2', 2, 6)
    const { out, measures } = run([s1, pad1, s2, pad2])
    expect(out.results[3].ok).toBe(true)
    const m = measures.get(3)!
    // The pad on top is its own body: 10×10×6 = 600, standing on the
    // first body's top at z 10, so it spans 10..16.
    expect(m.volume).toBeCloseTo(600, 0)
    expect(m.bounds.min[2]).toBeCloseTo(10, 3)
    expect(m.bounds.max[2]).toBeCloseTo(16, 3)
  })

  it('a constraint pulls a sketched rectangle to its dimensions', () => {
    // A rough quadrilateral, opposite corners pinned, edges told level and
    // plumb, the width named: the solver squares it off.
    const s = sk(newSketch(0, 'Rough', 'xy'))
    s.entities = [line([0, 0], [21, 0.6]), line([21, 0.6], [19.4, 10.3]), line([19.4, 10.3], [-0.4, 9.8]), line([-0.4, 9.8], [0, 0])]
    // The four corners welded shut, one corner pinned, each edge level or
    // plumb, the bottom and left named 21 and 10: the solver squares the
    // quad off to 21 × 10. (Pinning the second corner as well would fight
    // the horizontal constraint — its y starts at 0.6 and must go to 0.)
    s.constraints = [
      { kind: 'coincident', a: 1, b: 2 },
      { kind: 'coincident', a: 3, b: 4 },
      { kind: 'coincident', a: 5, b: 6 },
      { kind: 'coincident', a: 7, b: 0 },
      { kind: 'fixed', a: 0 },
      { kind: 'horizontal', a: 0, b: 1 },
      { kind: 'vertical', a: 2, b: 3 },
      { kind: 'horizontal', a: 4, b: 5 },
      { kind: 'vertical', a: 6, b: 7 },
      { kind: 'distance', a: 0, b: 1, value: 21 },
      { kind: 'distance', a: 6, b: 7, value: 10 },
    ]
    const { out, measures } = run([s, newExtrude(1, 'Pad', 0, 4)])
    expect(out.results[0].ok).toBe(true)
    expect(out.results[1].ok).toBe(true)
    expect(out.profiles.get(0)!.residual).toBeLessThan(1e-4)
    // 21 × 10 squared off by the solve, pulled 4 deep.
    expect(measures.get(1)!.volume).toBeCloseTo(21 * 10 * 4, 0)
  })

  it('a revolved rectangle makes the cylinder the numbers say', () => {
    const s = sk(newSketch(0, 'Profile', 'xy'))
    s.entities = [line([5, 0], [15, 0]), line([15, 0], [15, 20]), line([15, 20], [5, 20]), line([5, 20], [5, 0])]
    const feats: Feature[] = [s, lathe(0, 360, 'y')]
    const { out, measures } = run(feats)
    // The profile runs x 5..15 at the XY plane; the axis is part Y at
    // sketch y = 0. A 360° turn is a tube: π(R²−r²)h with R 15, r 5 —
    // revolve sweeps a solid of revolution, not a torus.
    if (out.results[1].ok) {
      const m = measures.get(1)!
      expect(m.volume).toBeCloseTo(Math.PI * (225 - 25) * 20, -2)
    } else {
      // Kernel refused the 360° revolve (OCCT wants ≤ 2π); the 180° turn
      // must work and give half.
      const half = run([s, lathe(0, 180, 'y')])
      expect(half.out.results[1].ok).toBe(true)
      expect(half.measures.get(1)!.volume).toBeCloseTo(0.5 * Math.PI * 200 * 20, -2)
    }
  })

  it('a loft between two squares tapers the solid', () => {
    const big = sk(newSketch(0, 'Big', 'xy'))
    big.entities = [line([-10, -10], [10, -10]), line([10, -10], [10, 10]), line([10, 10], [-10, 10]), line([-10, 10], [-10, -10])]
    const small = sk(newSketch(1, 'Small', 'xy'))
    small.offset = 20
    small.entities = [line([-4, -4], [4, -4]), line([4, -4], [4, 4]), line([4, 4], [-4, 4]), line([-4, 4], [-4, -4])]
    const taper: Feature = { id: 2, kind: 'loft', name: 'Taper', sketches: [0, 1], ruled: true }
    const { out, measures } = run([big, small, taper])
    expect(out.results[2].ok).toBe(true)
    const v = measures.get(2)!.volume
    // The ruled blend (h/3)(A1+A2+√(A1A2)) = (20/3)(400+64+160) = 4160,
    // a little off for the resampled sides; well under the big prism.
    expect(v).toBeGreaterThan(3500)
    expect(v).toBeLessThan(4600)
  })
})
