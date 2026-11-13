// SPDX-License-Identifier: AGPL-3.0-only
// The kernel adapter under Node: the wasm loads in this thread, a box
// stands as a closed solid of its volume, a sketch's loops close into an
// outline with a hole and become a face, an extrude of a circle is a
// cylinder of π·r²·h, fillet and boolean answer, and STEP round-trips.

import { describe, expect, it } from 'vitest'
import type { SketchEntity } from '../core/types'
import { CadKernel, KernelError } from '../core/kernel'

const load = async () => await CadKernel.load()

describe('the CAD kernel', () => {
  it('loads in this thread and reports its version', async () => {
    const k = await load()
    expect(k.version).toContain('OCCT')
    k.dispose()
  })

  it('a box is one closed solid of its volume', async () => {
    const k = await load()
    const box = k.box(10, 20, 30)
    const m = k.measures(box)
    expect(m.closed).toBe(true)
    expect(m.valid).toBe(true)
    expect(m.volume).toBeCloseTo(6000, 3)
    expect(m.area).toBeCloseTo(2 * (10 * 20 + 20 * 30 + 30 * 10), 3)
    // Centred on x/y, standing on z=0.
    expect(m.bounds.min).toEqual([-5, -10, 0])
    expect(m.bounds.max).toEqual([5, 10, 30])
    k.release(box)
    k.dispose()
  })

  it('a cylinder of a sketched circle extrudes to π r² h', async () => {
    const k = await load()
    const faces = k.facesOfSketch([{ kind: 'circle', center: [0, 0], radius: 5 }], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] })
    expect(faces.length).toBe(1)
    const solid = k.extrude(faces[0], 0, 0, 10)
    const m = k.measures(solid)
    expect(m.closed).toBe(true)
    expect(m.volume).toBeCloseTo(Math.PI * 25 * 10, 2)
    k.release(solid)
    k.dispose()
  })

  it('a sketch with a hole closes into an island and its face carries the hole', async () => {
    const k = await load()
    // A 20×20 square outline, a Ø8 hole through the middle.
    const entities: SketchEntity[] = [
      { kind: 'line', from: [-10, -10], to: [10, -10] },
      { kind: 'line', from: [10, -10], to: [10, 10] },
      { kind: 'line', from: [10, 10], to: [-10, 10] },
      { kind: 'line', from: [-10, 10], to: [-10, -10] },
      { kind: 'circle', center: [0, 0], radius: 4 },
    ]
    const faces = k.facesOfSketch([...entities], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] })
    expect(faces.length).toBe(1)
    const solid = k.extrude(faces[0], 0, 0, 5)
    const m = k.measures(solid)
    expect(m.closed).toBe(true)
    expect(m.volume).toBeCloseTo((400 - Math.PI * 16) * 5, 1)
    k.release(solid)
    k.dispose()
  })

  it('booleans join, cut and intersect; the fillet answers on every edge of a box', async () => {
    const k = await load()
    const a = k.box(10, 10, 10)
    const b = k.translate(k.box(10, 10, 10), [5, 0, 0])
    const fused = k.fuse(a, b)
    expect(k.measures(fused).volume).toBeCloseTo(1500, 3)
    const c = k.translate(k.box(4, 4, 20), [0, 0, -5])
    const drilled = k.cut(fused, c)
    expect(k.measures(drilled).volume).toBeCloseTo(1500 - 16 * 10, 3)
    // The round wears every edge of a single body: a box's twelve.
    const plain = k.box(10, 10, 10)
    const rounded = k.filletAll(plain, 2)
    expect(k.measures(rounded).closed).toBe(true)
    // 10³ minus the corners and edges a r=2 fillet removes: between the
    // sphere bound (8³ + sphere of r2) and the plain cube.
    const v = k.measures(rounded).volume
    expect(v).toBeLessThan(1000)
    expect(v).toBeGreaterThan(800 + (4 / 3) * Math.PI * 8 - 1)
    // The chamfer cuts a box's corners off square.
    const chamfered = k.chamferAll(k.box(10, 10, 10), 2)
    expect(k.measures(chamfered).volume).toBeLessThan(1000)
    for (const s of [a, b, fused, c, drilled, plain, rounded, chamfered]) k.release(s)
    k.dispose()
  })

  it('a revolve of a sketched rectangle about an axis makes a ring', async () => {
    const k = await load()
    // A 4×4 square from x=8 to 12, revolved a full turn about Z: a torus
    // of square section, volume 2π·R·A = 2π·10·16. The profile is sketched
    // in a plane running through the axis — the XZ plane, whose normal is
    // +Y and whose sketch-y falls along −Z — as every CAD puts a revolve's
    // sketch: a section through the spin, not a plate across it.
    const faces = k.facesOfSketch(
      [
        { kind: 'line', from: [8, -2], to: [12, -2] },
        { kind: 'line', from: [12, -2], to: [12, 2] },
        { kind: 'line', from: [12, 2], to: [8, 2] },
        { kind: 'line', from: [8, 2], to: [8, -2] },
      ],
      { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 1, 0] },
    )
    const solid = k.revolve(faces[0], [0, 0, 0], [0, 0, 1], 2 * Math.PI)
    const m = k.measures(solid)
    expect(m.closed).toBe(true)
    expect(m.volume).toBeCloseTo(2 * Math.PI * 10 * 16, 1)
    k.release(solid)
    k.dispose()
  })

  it('a loft between two loops tapers a prism', async () => {
    const k = await load()
    const square = (x: number, y: number, z: number): [number, number, number][] => [
      [-x, -y, z],
      [x, -y, z],
      [x, y, z],
      [-x, y, z],
      [-x, -y, z],
    ]
    const lower = square(10, 10, 0)
    const upper = square(5, 5, 10)
    const solid = k.loftLoops([lower, upper], true)
    const m = k.measures(solid)
    expect(m.closed).toBe(true)
    // A ruled prism between 20×20 and 10×10 at h=10: volume between
    // 1000 and 4000; the exact ruled loft is 7000/3 — bounded loosely.
    expect(m.volume).toBeGreaterThan(1000)
    expect(m.volume).toBeLessThan(4000)
    k.release(solid)
    k.dispose()
  })

  it('STEP text round-trips a filleted body', async () => {
    const k = await load()
    const box = k.filletAll(k.box(10, 10, 10), 2)
    const step = k.exportStep([box])
    expect(step).toContain('ISO-10303-21')
    const back = k.importStep(step)
    expect(k.measures(back).volume).toBeCloseTo(k.measures(box).volume, 3)
    k.release(back)
    k.release(box)
    k.dispose()
  })

  it('an STL export answers bytes, an import reads them back', async () => {
    const k = await load()
    const sphere = k.sphere(7)
    const stl = k.exportStl([sphere], 0.2)
    expect(stl).toBeInstanceOf(Uint8Array)
    expect(stl.length).toBeGreaterThan(84)
    const back = k.importStl(stl)
    const m = k.measures(back)
    // A tessellated sphere of r=7 read back: the mesh sits inside the
    // true surface, so its volume runs a few percent under 4/3·π·343.
    const trueVolume = (4 / 3) * Math.PI * 343
    expect(m.volume / trueVolume).toBeGreaterThan(0.93)
    expect(m.volume).toBeLessThan(trueVolume)
    k.release(back)
    k.release(sphere)
    k.dispose()
  })

  it('a shell hollows a box open through its top face', async () => {
    const k = await load()
    const box = k.box(20, 20, 20)
    const centers = k.faceCenters(box)
    expect(centers.length).toBe(6)
    const top = centers.reduce((best, c, i) => (c[2] > centers[best][2] ? i : best), 0)
    const hollow = k.shell(box, 2, (i) => i === top)
    const m = k.measures(hollow)
    expect(m.closed).toBe(true)
    // 20³ minus the open cavity: 16×16 from z=2 to the open top at z=20,
    // 8000 − 4608 = 3392.
    expect(m.volume).toBeCloseTo(3392, 0)
    k.release(box)
    k.release(hollow)
    k.dispose()
  })

  it('an empty sketch refuses with its words', async () => {
    const k = await load()
    expect(() => k.facesOfSketch([], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] })).toThrow(KernelError)
    k.dispose()
  })

  it('patterns repeat: linear fuses its copies, circular turns them about the axis', async () => {
    const k = await load()
    const one = k.cylinder(3, 10)
    const row = k.linearPattern(one, [1, 0, 0], 10, 3)
    expect(k.measures(row).volume).toBeCloseTo(3 * Math.PI * 9 * 10, 1)
    const wheel = k.translate(k.box(2, 1, 4), [8, 0, 0])
    const spokes = k.circularPattern(wheel, [0, 0, 0], [0, 0, 1], 2 * Math.PI, 6)
    expect(k.measures(spokes).volume).toBeCloseTo(6 * 8, 2)
    for (const s of [one, row, wheel, spokes]) k.release(s)
    k.dispose()
  })
})
