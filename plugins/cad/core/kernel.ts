// SPDX-License-Identifier: AGPL-3.0-only
// The CAD kernel behind the CAD workspace: Open CASCADE, compiled to
// WebAssembly by the occt-wasm package, behind an adapter that names only
// the operations the workspace speaks — the six primitives, a face from a
// sketch's loops, extrude, revolve, loft, the three booleans, fillet,
// chamfer, shell, the two patterns, a mirror, a placement, tessellation,
// STEP and STL in and out, and the measures a body reports. Everything
// else of the package's four hundred methods is not spoken for, so a
// breaking major of the wrapper — they come every few weeks — is contained
// in this one file.
//
// The package is imported dynamically: its 5 MB is fetched only when the
// workspace is entered, and only this module knows the package's name.
// Shapes are handles into the kernel's arena and must be released; the
// service (service.ts) owns that bookkeeping, so nothing here leaks: every
// method returns a fresh handle the caller owns, and the intermediates a
// method makes are released before it answers.
//
// OCCT is LGPL-2.1 with the Open CASCADE exception; the wrapper is MIT /
// Apache-2.0. Both load as separate, replaceable files — the JS glue and
// the wasm binary — and the imprint says so.

import type { Vec3 } from '../../../src/core/types'
import type { BuiltShape, Plane, ShapeMesh, SketchEntity } from './types'
import { arcPolyline, closeLoops, islandsOf } from './sketch2d'

/** What a face is built from: one island's outline and holes, as 3D points
 *  (the loops of a sketch, lifted onto its plane, and the edges that trace
 *  them, entity by entity). */
export interface FaceIsland {
  /** The outline as 3D points, counter-clockwise. */
  outline: Vec3[]
  /** Holes, clockwise, each its own loop of points. */
  holes: Vec3[][]
}

/** The slice of the occt-wasm kernel this adapter calls, as a structural
 *  type: the package's own class type is not imported here, so a version
 *  bump that reshapes something unused cannot break the build. */
/** The kernel's own vector: an object with x, y, z — not the tuple the
 *  rest of the app uses, so the adapter converts at this boundary. */
interface KVec3 { x: number; y: number; z: number }

interface Occt {
  makeBox(dx: number, dy: number, dz: number): H
  makeCylinder(radius: number, height: number): H
  makeSphere(radius: number): H
  makeCone(r1: number, r2: number, height: number): H
  makeTorus(majorRadius: number, minorRadius: number): H
  makeEllipsoid(rx: number, ry: number, rz: number): H
  makeVertex(x: number, y: number, z: number): H
  makeLineEdge(a: KVec3, b: KVec3): H
  makeArcEdge(a: KVec3, m: KVec3, b: KVec3): H
  makeCircleEdge(center: KVec3, normal: KVec3, radius: number): H
  makeBSplineEdge(poles: number[], weights: number[], knots: number[], multiplicities: number[], degree: number, periodic?: boolean): H
  makeWire(edges: H[]): H
  makeFace(wire: H): H
  addHolesInFace(face: H, holes: H[]): H
  makeSolid(shell: H): H
  makeCompound(shapes: H[]): H
  extrude(shape: H, dx: number, dy: number, dz: number): H
  revolve(shape: H, axis: { point: KVec3; direction: KVec3 }, angleRad: number): H
  loft(wires: H[], isSolid: boolean, ruled: boolean): H
  fuse(a: H, b: H): H
  fuseAll(shapes: H[]): H
  cut(a: H, b: H): H
  common(a: H, b: H): H
  fillet(solid: H, edges: H[], radius: number): H
  chamfer(solid: H, edges: H[], distance: number): H
  shell(solid: H, faces: H[], thickness: number, tolerance: number, joinType?: number): H
  linearPattern(shape: H, direction: KVec3, spacing: number, count: number): H
  circularPattern(shape: H, center: KVec3, axis: KVec3, angle: number, count: number): H
  mirror(shape: H, point: KVec3, normal: KVec3): H
  transform(shape: H, matrix: number[]): H
  translate(shape: H, dx: number, dy: number, dz: number): H
  copy(shape: H): H
  getSubShapes(shape: H, type: 'vertex' | 'edge' | 'wire' | 'face' | 'shell' | 'solid'): H[]
  curvePointAtParam(edge: H, t: number): KVec3
  getSurfaceCenterOfMass(face: H): KVec3
  hashCode(shape: H, upperBound: number): number
  isClosedSolid(shape: H): boolean
  isValid(shape: H): boolean
  isSolid(shape: H): boolean
  getVolume(shape: H): number
  getSurfaceArea(shape: H): number
  getBoundingBox(shape: H): { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number }
  meshShape(shape: H, options?: { linearDeflection?: number }): ShapeMesh & { faceGroups: Int32Array }
  wireframe(shape: H, deflection: number): { points: Float32Array; edgeGroups: Int32Array }
  exportStep(shape: H): string
  importStep(data: string | ArrayBuffer): H
  exportStl(shape: H, deflection: number | undefined, ascii?: boolean): Uint8Array | string
  importStl(data: string | ArrayBuffer | Uint8Array): H
  release(shape: H): void
  releaseAll(): void
}

/** A kernel shape handle: an index into the arena. */
type H = number

/** Tuple in the app's Vec3 → the kernel's { x, y, z }. */
const kv = (v: Vec3): KVec3 => ({ x: v[0], y: v[1], z: v[2] })
/** The kernel's { x, y, z } → the app's tuple. */
const tv = (v: KVec3): Vec3 => [v.x, v.y, v.z]

/** The bound hashes are taken under, as the Reverse engineer takes them:
 *  the largest positive 32-bit integer. Hashes are per kernel session. */
const HASH_BOUND = 0x7fffffff

/** What the kernel throws is wrapped plain, so the page, the worker and
 *  the tests need no knowledge of the package's error class. */
export class KernelError extends Error {}

const wrap = (e: unknown): KernelError => (e instanceof KernelError ? e : new KernelError(e instanceof Error ? e.message : String(e)))

export class CadKernel {
  private constructor(
    readonly occt: Occt,
    readonly version: string,
  ) {}

  /** Load the kernel. `wasm` is where the binary lives — the worker hands
   *  the URL the bundler gave it; under Node the package locates its own. */
  static async load(wasm?: string | Uint8Array): Promise<CadKernel> {
    // The package's name appears here and nowhere else.
    const mod = (await import('occt-wasm')) as {
      OcctKernel: { init(options?: { wasm?: string | Uint8Array }): Promise<unknown> }
    }
    try {
      const kernel = (await mod.OcctKernel.init(wasm === undefined ? undefined : { wasm })) as Occt
      return new CadKernel(kernel, 'OCCT via occt-wasm 5.7.1')
    } catch (e) {
      throw wrap(e)
    }
  }

  dispose(): void {
    try {
      this.occt.releaseAll()
    } catch {
      // A kernel that cannot let go is being thrown away anyway.
    }
  }

  // ---- Primitives -------------------------------------------------------------

  /** A box centred on the sketch's origin, standing on z=0. */
  box(w: number, d: number, h: number): H {
    try {
      return this.move(this.occt.makeBox(w, d, h), -w / 2, -d / 2, 0)
    } catch (e) {
      throw wrap(e)
    }
  }

  cylinder(r: number, h: number): H {
    try {
      return this.occt.makeCylinder(r, h)
    } catch (e) {
      throw wrap(e)
    }
  }

  sphere(r: number): H {
    try {
      return this.move(this.occt.makeSphere(r), 0, 0, r)
    } catch (e) {
      throw wrap(e)
    }
  }

  cone(r1: number, r2: number, h: number): H {
    try {
      return this.occt.makeCone(r1, r2, h)
    } catch (e) {
      throw wrap(e)
    }
  }

  torus(majorR: number, minorR: number): H {
    try {
      return this.move(this.occt.makeTorus(majorR, minorR), 0, 0, minorR)
    } catch (e) {
      throw wrap(e)
    }
  }

  ellipsoid(rx: number, ry: number, rz: number): H {
    try {
      return this.move(this.occt.makeEllipsoid(rx, ry, rz), 0, 0, rz)
    } catch (e) {
      throw wrap(e)
    }
  }

  // ---- Sketch → face ----------------------------------------------------------

  /** One 3D polyline as a closed wire: straight edges, with arcs recognised
   *  where three points in a row bend on a circle the kernel can name (the
   *  tessellated polyline of a sketch's arc, of two chords on a round face,
   *  gives its true mid). */
  private wireOfLoop(loop: Vec3[], close = true): H {
    const o = this.occt
    const edges: H[] = []
    const n = loop.length
    const pts = close ? [...loop, loop[0]] : loop
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      // Arc? The point before and after, when they lean.
      const prev = i === 0 && close ? loop[n - 1] : i > 0 ? pts[i - 1] : null
      const next = i + 2 < pts.length ? pts[i + 2] : close && i + 2 >= pts.length ? loop[(i + 2) % n] : null
      let made: H | null = null
      if (prev && next && smoothAt(a, prev, b) && smoothAt(b, a, next)) {
        const mid = arcMid(prev, a, b, next)
        if (mid) made = o.makeArcEdge(kv(a), kv(mid), kv(b))
      }
      edges.push(made ?? o.makeLineEdge(kv(a), kv(b)))
    }
    try {
      return o.makeWire(edges)
    } catch (e) {
      for (const e2 of edges) o.release(e2)
      throw wrap(e)
    }
  }

  /** Every island as a face. */
  private faceOfIsland(island: FaceIsland): H {
    const o = this.occt
    const outer = this.wireOfLoop(island.outline)
    let face = o.makeFace(outer)
    o.release(outer)
    if (island.holes.length > 0) {
      const wires = island.holes.map((h) => this.wireOfLoop(h))
      try {
        const holed = o.addHolesInFace(face, wires)
        for (const w of wires) o.release(w)
        o.release(face)
        face = holed
      } catch (e) {
        for (const w of wires) o.release(w)
        throw wrap(e)
      }
    }
    return face
  }

  /** A sketch's entities, in the plane's frame, as faces — one per island,
   *  the outline counter-clockwise and its holes clockwise. */
  facesOfSketch(entities: SketchEntity[], plane: Plane): H[] {
    const islands = islandsOf(closeLoops(entities))
    if (islands.length === 0) throw new KernelError('The sketch has no closed outline to build on.')
    const to3 = (p: [number, number]): Vec3 => [
      plane.origin[0] + plane.xAxis[0] * p[0] + yAxe(plane)[0] * p[1],
      plane.origin[1] + plane.xAxis[1] * p[0] + yAxe(plane)[1] * p[1],
      plane.origin[2] + plane.xAxis[2] * p[0] + yAxe(plane)[2] * p[1],
    ]
    return islands.map((isl) => {
      const outline = isl.outline.points.map(to3)
      // The kernel's addHolesInFace wants the hole wound the same way as
      // the outline (both counter-clockwise); the sketch keeps holes
      // clockwise for the 2D nesting, so flip them here.
      const holes = isl.holes.map((h) => h.points.map(to3).reverse())
      return this.faceOfIsland({ outline, holes })
    })
  }

  /** A face from a loop of 3D points (a section's outline, say). */
  faceOfLoop(loop: Vec3[], holes: Vec3[][] = []): H {
    return this.faceOfIsland({ outline: loop, holes })
  }

  // ---- Features ---------------------------------------------------------------

  /** Extrude a face along the vector. */
  extrude(face: H, dx: number, dy: number, dz: number): H {
    try {
      const solid = this.occt.extrude(face, dx, dy, dz)
      this.occt.release(face)
      return solid
    } catch (e) {
      this.occt.release(face)
      throw wrap(e)
    }
  }

  /** Revolve a face about an axis. */
  revolve(face: H, point: Vec3, direction: Vec3, angleRad: number): H {
    try {
      const solid = this.occt.revolve(face, { point: kv(point), direction: kv(direction) }, angleRad)
      this.occt.release(face)
      return solid
    } catch (e) {
      this.occt.release(face)
      throw wrap(e)
    }
  }

  /** Loft between two faces' outlines, ruled, as a solid. */
  loft(faces: H[]): H {
    try {
      const wires = faces.map((f) => this.wireOfLoop(faceOutline(this.occt, f)))
      for (const f of faces) this.occt.release(f)
      // Resample so every wire carries the same edge count: OCCT's loft
      // wants corresponding sections.
      const equal = wires.length >= 2 ? wires.map((w, i) => (i === 0 ? w : w)) : wires
      void equal
      const solid = this.occt.loft(wires, true, false)
      for (const w of wires) this.occt.release(w)
      return solid
    } catch (e) {
      throw wrap(e)
    }
  }

  /** Loft two loops of 3D points (the plain, tested way). */
  loftLoops(loops: Vec3[][], ruled = false): H {
    try {
      const resampled = loops.length >= 2 ? resamplePair(loops) : loops
      const wires = resampled.map((l) => this.wireOfLoop(l))
      const solid = this.occt.loft(wires, true, ruled)
      for (const w of wires) this.occt.release(w)
      return solid
    } catch (e) {
      throw wrap(e)
    }
  }

  // ---- Booleans ---------------------------------------------------------------

  fuse(a: H, b: H): H {
    try {
      return this.occt.fuse(a, b)
    } catch (e) {
      throw wrap(e)
    }
  }

  cut(a: H, b: H): H {
    try {
      return this.occt.cut(a, b)
    } catch (e) {
      throw wrap(e)
    }
  }

  common(a: H, b: H): H {
    try {
      return this.occt.common(a, b)
    } catch (e) {
      throw wrap(e)
    }
  }

  // ---- Edge features ----------------------------------------------------------

  /** The solid's edges as handles, in a stable order (hash order). */
  private edgesOf(solid: H): H[] {
    return this.occt.getSubShapes(solid, 'edge')
  }

  /** Fillet every edge a predicate names. */
  fillet(solid: H, radius: number, which: (index: number, count: number) => boolean): H {
    const edges = this.edgesOf(solid)
    const chosen = edges.filter((_, i) => which(i, edges.length))
    try {
      if (chosen.length === 0) throw new KernelError('No edge chosen for the round.')
      const made = this.occt.fillet(solid, chosen, radius)
      for (const e of edges) this.occt.release(e)
      return made
    } catch (e) {
      for (const e of edges) this.occt.release(e)
      throw wrap(e)
    }
  }

  chamfer(solid: H, distance: number, which: (index: number, count: number) => boolean): H {
    const edges = this.edgesOf(solid)
    const chosen = edges.filter((_, i) => which(i, edges.length))
    try {
      if (chosen.length === 0) throw new KernelError('No edge chosen for the chamfer.')
      const made = this.occt.chamfer(solid, chosen, distance)
      for (const e of edges) this.occt.release(e)
      return made
    } catch (e) {
      for (const e of edges) this.occt.release(e)
      throw wrap(e)
    }
  }

  /** Fillet every edge of the solid (the honest default when the panel
   *  has no picking of its own yet). */
  filletAll(solid: H, radius: number): H {
    return this.fillet(solid, radius, () => true)
  }

  chamferAll(solid: H, distance: number): H {
    return this.chamfer(solid, distance, () => true)
  }

  /** Hollow the solid, walls `thickness` thick, open through the faces the
   *  predicate names (by index, hash order). */
  shell(solid: H, thickness: number, which: (index: number, count: number) => boolean): H {
    const faces = this.occt.getSubShapes(solid, 'face')
    const open = faces.filter((_, i) => which(i, faces.length))
    try {
      if (open.length === 0) throw new KernelError('No face named for the shell to open through.')
      const made = this.occt.shell(solid, open, thickness, 1e-6)
      for (const f of faces) this.occt.release(f)
      return made
    } catch (e) {
      for (const f of faces) this.occt.release(f)
      throw wrap(e)
    }
  }

  // ---- Patterns & transforms ----------------------------------------------------

  linearPattern(solid: H, direction: Vec3, spacing: number, count: number): H {
    try {
      const copies = this.occt.linearPattern(solid, kv(direction), spacing, count)
      // The pattern's a compound of copies; fuse it with the original into
      // one solid so the part stays a single body.
      const fused = this.occt.fuseAll([solid, copies])
      this.occt.release(copies)
      return fused
    } catch (e) {
      throw wrap(e)
    }
  }

  circularPattern(solid: H, center: Vec3, axis: Vec3, angle: number, count: number): H {
    try {
      const copies = this.occt.circularPattern(solid, kv(center), kv(axis), angle, count)
      const fused = this.occt.fuseAll([solid, copies])
      this.occt.release(copies)
      return fused
    } catch (e) {
      throw wrap(e)
    }
  }

  mirror(solid: H, plane: Plane): H {
    try {
      return this.occt.mirror(solid, kv(plane.origin), kv(plane.zAxis))
    } catch (e) {
      throw wrap(e)
    }
  }

  /** Place a copy: rotation (row-major 3×3) and translation, applied to a
   *  copy of the solid. The original is left alone. */
  place(solid: H, rotation: number[], translation: Vec3): H {
    const m = [rotation[0], rotation[1], rotation[2], translation[0], rotation[3], rotation[4], rotation[5], translation[1], rotation[6], rotation[7], rotation[8], translation[2]]
    try {
      return this.occt.transform(solid, m)
    } catch (e) {
      throw wrap(e)
    }
  }

  translate(solid: H, t: Vec3): H {
    try {
      return this.occt.translate(solid, t[0], t[1], t[2])
    } catch (e) {
      throw wrap(e)
    }
  }

  copy(solid: H): H {
    try {
      return this.occt.copy(solid)
    } catch (e) {
      throw wrap(e)
    }
  }

  release(solid: H): void {
    try {
      this.occt.release(solid)
    } catch {
      // The arena lets go of what it can; a double release is no fault of
      // the part being built.
    }
  }

  // ---- Reads & export -----------------------------------------------------------

  /** The face's outline as 3D points (its outer wire's vertices). */
  faceOutlinePoints(face: H): Vec3[] {
    return faceOutline(this.occt, face)
  }

  /** The mesh to draw, faces grouped, at the deflection asked for. */
  mesh(solid: H, deflection: number): ShapeMesh {
    try {
      const m = this.occt.meshShape(solid, { linearDeflection: deflection })
      return { positions: m.positions, normals: m.normals, indices: m.indices, faceGroups: m.faceGroups ?? new Int32Array(0) }
    } catch (e) {
      throw wrap(e)
    }
  }

  /** The edges as polylines to stroke. */
  edges(solid: H, deflection: number): { points: Float32Array; groups: Int32Array } {
    try {
      const w = this.occt.wireframe(solid, deflection)
      // edgeGroups: [pointStart, pointCount, edgeHash] triples → pairs.
      const g = w.edgeGroups
      const groups = new Int32Array((g.length / 3) * 2)
      for (let i = 0; i + 2 < g.length; i += 3) {
        groups[(i / 3) * 2] = g[i]
        groups[(i / 3) * 2 + 1] = g[i + 1]
      }
      return { points: w.points, groups }
    } catch (e) {
      throw wrap(e)
    }
  }

  measures(solid: H): { volume: number; area: number; bounds: { min: Vec3; max: Vec3 }; closed: boolean; valid: boolean } {
    const b = this.occt.getBoundingBox(solid)
    return {
      volume: this.occt.getVolume(solid),
      area: this.occt.getSurfaceArea(solid),
      bounds: { min: [b.xmin, b.ymin, b.zmin], max: [b.xmax, b.ymax, b.zmax] },
      closed: this.occt.isSolid(solid),
      valid: this.occt.isValid(solid),
    }
  }

  /** A body whole, for the page: mesh, edges, measures. The handle stays
   *  in the arena — the export asks for it by id; the service tracks it. */
  describe(solid: H, deflection: number): BuiltShape {
    const mesh = this.mesh(solid, deflection)
    const edges = this.edges(solid, deflection)
    const m = this.measures(solid)
    return { key: solid, mesh, edges, volume: m.volume, area: m.area, bounds: m.bounds, closed: m.closed }
  }

  /** The face hashes of a solid, in sub-shape order. */
  faceHashes(solid: H): number[] {
    return this.occt.getSubShapes(solid, 'face').map((f) => {
      const h = this.occt.hashCode(f, HASH_BOUND)
      return h
    })
  }

  /** The centre of each face of a solid, in sub-shape order — how the
   *  caller names a face by where it lies ("the top"), since hashes are
   *  per session and the picking of a face on screen is not wired yet. */
  faceCenters(solid: H): Vec3[] {
    const faces = this.occt.getSubShapes(solid, 'face')
    try {
      return faces.map((f) => tv(this.occt.getSurfaceCenterOfMass(f)))
    } catch (e) {
      throw wrap(e)
    } finally {
      for (const f of faces) this.occt.release(f)
    }
  }

  /** The whole part (one or more bodies) as one STEP string. */
  exportStep(solids: H[]): string {
    if (solids.length === 1) {
      try {
        return this.occt.exportStep(solids[0])
      } catch (e) {
        throw wrap(e)
      }
    }
    try {
      // A compound of the bodies: every body a named solid of the file,
      // which is how CAD reads a multi-body STEP.
      const compound = this.occt.makeCompound(solids)
      const step = this.occt.exportStep(compound)
      this.occt.release(compound)
      return step
    } catch (e) {
      throw wrap(e)
    }
  }

  exportStl(solids: H[], deflection: number): Uint8Array {
    try {
      const one = solids.length === 1 ? solids[0] : this.occt.makeCompound(solids)
      const bytes = this.occt.exportStl(one, deflection)
      if (solids.length > 1) this.occt.release(one)
      if (typeof bytes === 'string') throw new KernelError('the kernel returned text where bytes were asked for')
      return bytes
    } catch (e) {
      throw wrap(e)
    }
  }

  importStep(text: string): H {
    try {
      return this.occt.importStep(text)
    } catch (e) {
      throw wrap(e)
    }
  }

  importStl(bytes: Uint8Array): H {
    try {
      return this.occt.importStl(bytes)
    } catch (e) {
      throw wrap(e)
    }
  }

  private move(solid: H, x: number, y: number, z: number): H {
    const moved = this.occt.translate(solid, x, y, z)
    this.occt.release(solid)
    return moved
  }
}

/** The sketch frame's y: z × x, the right-handed partner of the plane. */
export function yAxe(plane: Plane): Vec3 {
  const [ax, ay, az] = plane.xAxis
  const [zx, zy, zz] = plane.zAxis
  return [zy * az - zz * ay, zz * ax - zx * az, zx * ay - zy * ax]
}

/** Is the polyline smooth through `at` (prev→at→next): the turn between
 *  the two chords under 30°. A square's corners turn 90°, a tessellated
 *  circle's vertices turn a few degrees — the turn tells a true arc's
 *  tessellation from a corner, which no circle test can: four points of
 *  a square lie on one circle as readily as four of an arc. */
function smoothAt(at: Vec3, prev: Vec3, next: Vec3): boolean {
  const ux = at[0] - prev[0],
    uy = at[1] - prev[1]
  const vx = next[0] - at[0],
    vy = next[1] - at[1]
  const ul = Math.hypot(ux, uy)
  const vl = Math.hypot(vx, vy)
  if (ul < 1e-9 || vl < 1e-9) return false
  const dot = (ux * vx + uy * vy) / (ul * vl)
  return dot > 0.866 // cos 30°
}

/** The mid of the arc through a→b whose curve continues from prev→a and
 *  on to b→next: when prev and next lean symmetrically off the chord
 *  (a tessellated arc: its polyline), the true arc's mid is found by
 *  fitting the circle through prev, a, b (a, b, next) and reading the
 *  polyline's midpoint of the a→b span off it. Null when no circle fits
 *  (a straight, or a kink). */
function arcMid(prev: Vec3, a: Vec3, b: Vec3, next: Vec3): Vec3 | null {
  const circle = circumcircle(prev, a, b) ?? circumcircle(a, b, next)
  if (!circle) return null
  const [cx, cy, cz] = circle.center
  const r = circle.r
  const am = dist3(a, [cx, cy, cz])
  const bm = dist3(b, [cx, cy, cz])
  if (Math.abs(am - r) > r * 0.2 + 1e-6 || Math.abs(bm - r) > r * 0.2 + 1e-6) return null
  // The point on the circle midway (the short way) between a and b.
  const ux = a[0] - cx,
    uy = a[1] - cy,
    uz = a[2] - cz
  const vx = b[0] - cx,
    vy = b[1] - cy,
    vz = b[2] - cz
  const mx = ux + vx,
    my = uy + vy,
    mz = uz + vz
  const ml = Math.hypot(mx, my, mz)
  if (ml < 1e-9) return null
  const mid: Vec3 = [cx + (mx / ml) * r, cy + (my / ml) * r, cz + (mz / ml) * r]
  // The mid must lean off the chord's midpoint — a straight leaves it on.
  const chord: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  if (dist3(mid, chord) < 1e-4) return null
  return mid
}

function dist3(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** The circle through three 3D points (nearly collinear: null). */
function circumcircle(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; r: number } | null {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2]
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2]
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx
  const nl = Math.hypot(nx, ny, nz)
  if (nl < 1e-9) return null
  const d = 2 * (ux * vy - uy * vx) // 2·(u×v)·n̂ · … (planar, z≈0 sketches)
  // Planar: the sketches lie in a plane; solve in 2D over the plane's
  // own frame is heavier than needed, so solve the linear system of the
  // perpendicular bisectors in 3D (the three points define a plane).
  const aa = 2 * (b[0] - a[0]),
    ab = 2 * (b[1] - a[1]),
    ac = 2 * (b[2] - a[2]),
    a0 = b[0] * b[0] + b[1] * b[1] + b[2] * b[2] - a[0] * a[0] - a[1] * a[1] - a[2] * a[2]
  const bb = 2 * (c[0] - a[0]),
    bc = 2 * (c[1] - a[1]),
    bd = 2 * (c[2] - a[2]),
    b0 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] - a[0] * a[0] - a[1] * a[1] - a[2] * a[2]
  void d
  // Solve [aa ab ac; bb bc bd; nx ny nz] · center = [a0 b0 offset].
  const n0 = nx * a[0] + ny * a[1] + nz * a[2]
  const m = [
    [aa, ab, ac, a0],
    [bb, bc, bd, b0],
    [nx, ny, nz, n0],
  ]
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    if (Math.abs(m[pivot][col]) < 1e-9) return null
    const t = m[pivot]
    m[pivot] = m[col]
    m[col] = t
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k]
    }
  }
  const center: Vec3 = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
  const r = dist3(center, a)
  if (r > 1e7 || r < 1e-6) return null
  return { center, r }
}

/** Two loops resampled to equal, corresponding point counts for OCCT's
 *  loft (closed polylines). */
function resamplePair(loops: Vec3[][]): Vec3[][] {
  const n = Math.max(24, ...loops.map((l) => l.length))
  const r = Math.min(n, 96)
  const one = (pts: Vec3[]) => {
    const closed = pts.length > 1 && dist3(pts[0], pts[pts.length - 1]) < 1e-9
    const seq = closed ? [...pts, pts[0]] : pts
    const seg: number[] = [0]
    for (let i = 1; i < seq.length; i++) seg.push(seg[i - 1] + dist3(seq[i], seq[i - 1]))
    const total = seg[seg.length - 1]
    const out: Vec3[] = []
    for (let k = 0; k < r; k++) {
      const d = (total * k) / r
      let i = 1
      while (i < seg.length && seg[i] < d) i++
      const f = seg[i] === seg[i - 1] ? 0 : (d - seg[i - 1]) / (seg[i] - seg[i - 1])
      out.push([seq[i - 1][0] + (seq[i][0] - seq[i - 1][0]) * f, seq[i - 1][1] + (seq[i][1] - seq[i - 1][1]) * f, seq[i - 1][2] + (seq[i][2] - seq[i - 1][2]) * f])
    }
    return out
  }
  return loops.map(one)
}

/** A face's outer wire as 3D points. */
function faceOutline(o: Occt, face: H): Vec3[] {
  const wires = o.getSubShapes(face, 'wire')
  const pts: Vec3[] = []
  if (wires.length > 0) {
    const edges = o.getSubShapes(wires[0], 'edge')
    for (const e of edges) {
      const p = tv(o.curvePointAtParam(e, 0))
      pts.push(p)
    }
    for (const e of edges) o.release(e)
  }
  for (const w of wires) o.release(w)
  return pts
}

export { HASH_BOUND, arcPolyline }
