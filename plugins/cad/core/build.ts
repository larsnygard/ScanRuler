// SPDX-License-Identifier: AGPL-3.0-only
// The build: a feature list compiled in order to kernel shapes. The engine
// walks the list, builds each feature from the features it names, and
// hands back one result per feature — built, with the kernel handle of the
// shape it made, or failed with the sentence why.
//
// Handles are the caller's to own from the answer on: `build` returns the
// shape of every feature that made one, keyed by feature id; the caller
// (cadClient) shows them and releases them when the part is rebuilt.
//
// One rule keeps the bookkeeping honest: a feature whose inputs failed
// fails with "Blocked: …" naming the first reason, so a chain of features
// tells one story, not the kernel's raw words repeated down the list.

import type { Vec3 } from '../../../src/core/types'
import type { CadKernel } from './kernel'
import { closeLoops, entityPolyline, islandsOf } from './sketch2d'
import { datumPlane, extrudeVector, sketchPlane } from './frame'
import type { BuildResult, EdgeSelection, Feature } from './part'
import { featureDeps, solveEntities } from './part'
import type { Plane, SketchEntity } from './types'

/** A sketch settled on its plane: the solved entities, and how well the
 *  constraints settled. */
export interface Profile {
  plane: Plane
  entities: SketchEntity[]
  /** The constraint residual, mm; over ~0.01 the panel flags the sketch. */
  residual: number
}

export interface BuildOutput {
  /** One result per feature, in list order. */
  results: BuildResult[]
  /** The kernel handle of the shape each feature that made one, by
   *  feature id. The caller releases these. */
  shapes: Map<number, number>
  /** The settled profiles of the sketch features, by feature id. */
  profiles: Map<number, Profile>
}

/** The centre of every edge of a solid, in edge order, from its
 *  wireframe: how a fillet names "the edge nearest the point picked". */
function edgeCentersOf(k: CadKernel, solid: number): Vec3[] {
  const { points, groups } = k.edges(solid, 0.4)
  const out: Vec3[] = []
  for (let g = 0; g + 1 < groups.length; g += 2) {
    const start = groups[g]
    const count = groups[g + 1]
    if (count <= 0) {
      out.push([0, 0, 0])
      continue
    }
    let x = 0
    let y = 0
    let z = 0
    for (let i = 0; i < count; i++) {
      x += points[(start + i) * 3]
      y += points[(start + i) * 3 + 1]
      z += points[(start + i) * 3 + 2]
    }
    out.push([x / count, y / count, z / count])
  }
  return out
}

/** The edge test a fillet/chamfer runs: every edge, or the one nearest
 *  the point handed back (a pick on screen, a command's numbers). */
function edgePicker(k: CadKernel, solid: number, sel: EdgeSelection): (index: number, count: number) => boolean {
  if (sel.which === 'all') return () => true
  const centers = edgeCentersOf(k, solid)
  let nearest = -1
  let best = Infinity
  centers.forEach((c, j) => {
    const d = (c[0] - sel.point[0]) ** 2 + (c[1] - sel.point[1]) ** 2 + (c[2] - sel.point[2]) ** 2
    if (d < best) {
      best = d
      nearest = j
    }
  })
  return (j) => j === nearest
}

/** The loops a sketch profile carries, in part coordinates: each island's
 *  outline (holes do not loft), as rings of 3D points on the plane. */
function loopsOfProfile(p: Profile): Vec3[][] {
  const y = [
    p.plane.zAxis[1] * p.plane.xAxis[2] - p.plane.zAxis[2] * p.plane.xAxis[1],
    p.plane.zAxis[2] * p.plane.xAxis[0] - p.plane.zAxis[0] * p.plane.xAxis[2],
    p.plane.zAxis[0] * p.plane.xAxis[1] - p.plane.zAxis[1] * p.plane.xAxis[0],
  ] as Vec3
  const to3 = (pt: [number, number]): Vec3 => [
    p.plane.origin[0] + p.plane.xAxis[0] * pt[0] + y[0] * pt[1],
    p.plane.origin[1] + p.plane.xAxis[1] * pt[0] + y[1] * pt[1],
    p.plane.origin[2] + p.plane.xAxis[2] * pt[0] + y[2] * pt[1],
  ]
  const rings: Vec3[][] = []
  for (const isl of islandsOf(closeLoops(p.entities))) {
    const pts = isl.outline.points.map(to3)
    const closed = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] && pts[0][2] === pts[pts.length - 1][2]
    const ring = closed ? pts.slice(0, -1) : pts
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

export class PartBuilder {
  constructor(readonly kernel: CadKernel) {}

  /** Compile the feature list. `top` (the bounds of the last solid made)
   *  is what a sketch's plane sits on: a sketch with `on: 'top'` lies on
   *  the top face of the body grown before it — a pad on a pad. */
  build(features: Feature[], progress: (text: string) => void = () => {}): BuildOutput {
    const k = this.kernel
    const results: BuildResult[] = []
    const shapes = new Map<number, number>()
    const profiles = new Map<number, Profile>()
    const pos = new Map<number, number>()
    features.forEach((f, i) => pos.set(f.id, i))
    let top: { min: Vec3; max: Vec3 } | null = null

    /** The reason a named feature is unusable, as one sentence, or null. */
    const blockedBy = (id: number, wantsBody: boolean): string | null => {
      const index = pos.get(id) ?? -1
      if (index < 0) return `names feature ${id}, which is not in the list`
      const feature = features[index]
      const result = results[index]
      if (!result) return `feature ${id} (${feature.name}) comes after it in the list`
      if (!result.ok) return `feature ${id} (${feature.name}): ${result.reason}`
      if (wantsBody && !shapes.has(id)) return `feature ${id} (${feature.name}) made a profile, not a body to work on`
      return null
    }
    const fail = (i: number, reason: string) => results.push({ index: i, ok: false, reason })
    const made = (i: number, handle: number) => {
      shapes.set(features[i].id, handle)
      results.push({ index: i, ok: true, body: features[i].id })
    }

    for (let i = 0; i < features.length; i++) {
      const f = features[i]
      progress(`Building ${f.name || f.kind}…`)

      const wantsBody = f.kind !== 'extrude' && f.kind !== 'revolve' && f.kind !== 'loft'
      let stopped = false
      for (const d of featureDeps(f)) {
        const why = blockedBy(d, wantsBody)
        if (why) {
          fail(i, wantsBody ? `Blocked: ${why}` : why)
          stopped = true
          break
        }
      }
      if (stopped) continue

      try {
        switch (f.kind) {
          case 'box':
            made(i, k.box(f.width, f.depth, f.height))
            break
          case 'cylinder':
            made(i, k.cylinder(f.radius, f.height))
            break
          case 'sphere':
            made(i, k.sphere(f.radius))
            break
          case 'cone':
            made(i, k.cone(f.radius1, f.radius2, f.height))
            break
          case 'torus':
            made(i, k.torus(f.majorRadius, f.minorRadius))
            break
          case 'ellipsoid':
            made(i, k.ellipsoid(f.rx, f.ry, f.rz))
            break

          case 'sketch': {
            if (f.entities.length === 0) {
              fail(i, 'The sketch is empty.')
              break
            }
            const solved = solveEntities(f.entities, f.constraints)
            const plane = sketchPlane(f.plane, f.on === 'top' ? top : null, f.offset, f.shift)
            profiles.set(f.id, { plane, entities: solved.entities, residual: solved.residual })
            results.push({ index: i, ok: true, body: null })
            break
          }

          case 'extrude': {
            const p = profiles.get(f.sketch)!
            const v = extrudeVector(p.plane, f.depth)
            const faces = k.facesOfSketch(p.entities, p.plane)
            const solids = faces.map((face) => k.extrude(face, v[0], v[1], v[2]))
            made(i, solids.length === 1 ? solids[0] : k.occt.fuseAll(solids))
            break
          }

          case 'revolve': {
            const p = profiles.get(f.sketch)!
            const angle = (f.angleDeg * Math.PI) / 180
            if (angle <= 0) {
              fail(i, 'The revolve turns by no angle.')
              break
            }
            const axis: Vec3 = f.axis === 'x' ? [1, 0, 0] : f.axis === 'y' ? [0, 1, 0] : [0, 0, 1]
            const faces = k.facesOfSketch(p.entities, p.plane)
            const solids = faces.map((face) => k.revolve(face, [0, 0, 0], axis, angle))
            made(i, solids.length === 1 ? solids[0] : k.occt.fuseAll(solids))
            break
          }

          case 'loft': {
            const rings: Vec3[][] = []
            for (const s of f.sketches) {
              for (const ring of loopsOfProfile(profiles.get(s)!)) rings.push(ring)
            }
            if (rings.length < 2) {
              fail(i, 'A loft needs two closed profiles to run between.')
              break
            }
            made(i, k.loftLoops(rings, f.ruled))
            break
          }

          case 'boolean': {
            const a = shapes.get(f.a)!
            const b = shapes.get(f.b)!
            made(i, f.op === 'fuse' ? k.fuse(a, b) : f.op === 'cut' ? k.cut(a, b) : k.common(a, b))
            break
          }

          case 'fillet': {
            if (f.radius <= 0) {
              fail(i, 'The fillet has no radius.')
              break
            }
            const s = shapes.get(f.body)!
            made(i, k.fillet(s, f.radius, edgePicker(k, s, f.edges)))
            break
          }

          case 'chamfer': {
            if (f.distance <= 0) {
              fail(i, 'The chamfer has no distance.')
              break
            }
            const s = shapes.get(f.body)!
            made(i, k.chamfer(s, f.distance, edgePicker(k, s, f.edges)))
            break
          }

          case 'shell': {
            if (f.thickness <= 0) {
              fail(i, 'The shell has no wall thickness.')
              break
            }
            const s = shapes.get(f.body)!
            const centers = k.faceCenters(s)
            if (centers.length < 2) {
              fail(i, 'The body has too few faces to hollow.')
              break
            }
            const topFace = centers.reduce((best, c, j) => (c[2] > centers[best][2] ? j : best), 0)
            const bottomFace = centers.reduce((best, c, j) => (c[2] < centers[best][2] ? j : best), 0)
            const open = f.open.which === 'top' ? topFace : f.open.which === 'bottom' ? bottomFace : -1
            made(i, k.shell(s, f.thickness, (j) => j === open))
            break
          }

          case 'linearPattern': {
            if (f.count < 2) {
              fail(i, 'A pattern repeats at least twice.')
              break
            }
            const len = Math.hypot(f.direction[0], f.direction[1], f.direction[2])
            if (len < 1e-9) {
              fail(i, 'The pattern has no direction.')
              break
            }
            const dir: Vec3 = [f.direction[0] / len, f.direction[1] / len, f.direction[2] / len]
            made(i, k.linearPattern(shapes.get(f.body)!, dir, f.spacing, f.count))
            break
          }

          case 'circularPattern': {
            if (f.count < 2) {
              fail(i, 'A pattern repeats at least twice.')
              break
            }
            const axis: Vec3 = f.axis === 'x' ? [1, 0, 0] : f.axis === 'y' ? [0, 1, 0] : [0, 0, 1]
            made(i, k.circularPattern(shapes.get(f.body)!, f.center, axis, (f.angleDeg * Math.PI) / 180, f.count))
            break
          }

          case 'mirror': {
            const s = shapes.get(f.body)!
            made(i, k.mirror(s, datumPlane(f.plane), { fuse: true }))
            break
          }

          case 'component':
            made(i, k.place(shapes.get(f.body)!, f.placement.rotation, f.placement.translation))
            break
        }
      } catch (e) {
        fail(i, e instanceof Error ? e.message : String(e))
      }

      // A solid made: its bounds are the top the next sketch sits on.
      const answer = results[i]
      if (answer.ok) {
        try {
          top = k.measures(shapes.get(f.id)!).bounds
        } catch {
          top = null
        }
      }
    }

    return { results, shapes, profiles }
  }
}

/** The 2D outline of a profile for the page: each island's outline and
 *  holes as polylines in sketch coordinates (the panel draws them). */
export function profileOutlines(p: Profile): { outline: [number, number][]; holes: [number, number][][] }[] {
  return islandsOf(closeLoops(p.entities)).map((isl) => ({
    outline: isl.outline.points,
    holes: isl.holes.map((h) => h.points),
  }))
}

export { entityPolyline }
