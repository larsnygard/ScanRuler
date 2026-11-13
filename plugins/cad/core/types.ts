// SPDX-License-Identifier: AGPL-3.0-only
// The shapes the kernel hands back and the plain forms of the geometry that
// goes into it. The kernel lives behind CadKernel (kernel.ts); the worker
// between the page and it keeps solids by id between requests (ids), and
// what reaches a worker is plain JSON and typed arrays, as the structured
// clone of a postMessage requires.

import type { Vec3 } from '../../../src/core/types'

/** A solid, face, edge… as the worker hands it to the page: the id it keeps
 *  it under, its mesh to draw, and what it measures. */
export interface ShapeMesh {
  /** Triangle vertices, xyz interleaved. */
  positions: Float32Array
  /** Per-vertex unit normals, same order. */
  normals: Float32Array
  /** Triangle indices into positions. */
  indices: Uint32Array
  /** [triStart, triCount, faceHash] triples, from meshShape. */
  faceGroups: Int32Array
}

/** A body as a build leaves it: the id the export asks the worker for, the
 *  mesh to draw, its faces and edges, and how it measures. */
export interface BuiltShape {
  /** The worker's handle id, stable between builds that did not change it. */
  key: number
  mesh: ShapeMesh
  /** Edges sampled as polylines: [pointStart, pointCount] pairs into
   *  points (xyz interleaved), one pair per edge, in the order `indexes`
   *  counts them. */
  edges: { points: Float32Array; groups: Int32Array }
  volume: number
  area: number
  bounds: { min: Vec3; max: Vec3 }
  /** The solid is watertight (one closed shell). */
  closed: boolean
}

/** A plane in the part: an origin and two unit vectors, X and Z. A sketch
 *  lies on it, its x along X and its y along X×Z; its extrude direction is
 *  Z, flipped when the depth is negative. */
export interface Plane {
  origin: Vec3
  xAxis: Vec3
  zAxis: Vec3
}

/** One entity of a sketch's 2D outline, in the sketch's own millimetres.
 *  Points are [x, y]. */
export type SketchEntity =
  | { kind: 'line'; from: [number, number]; to: [number, number] }
  | { kind: 'circle'; center: [number, number]; radius: number }
  | { kind: 'arc'; center: [number, number]; radius: number; fromAngle: number; toAngle: number }
  | { kind: 'spline'; points: [number, number][]; closed: boolean }

/** A sketch as a build takes it: its plane and its entities. */
export interface Sketch {
  plane: Plane
  entities: SketchEntity[]
}

/** The six planes of the part's coordinate system, named as the panel names
 *  them. */
export type DatumPlane = 'xy' | 'yx' | 'xz' | 'zx' | 'yz' | 'zy'

/** A rigid placement: a rotation, row-major 3×3, and a translation. */
export interface Placement {
  rotation: number[]
  translation: Vec3
}

/** What a pick names on a drawn body, for a feature to work on:
 *  `body:<n>` the solid, `face:<n>:<hash>` a face by its build-time hash,
 *  `edge:<n>:<point>` the edge nearest a point on the body's mesh. */
export type TopoRef =
  | { kind: 'body'; body: number }
  | { kind: 'face'; body: number; hash: number }
  | { kind: 'edge'; body: number; point: Vec3 }

/** A feature's answer: built, or why it did not build. */
export type FeatureOutcome = { ok: true; body: number } | { ok: false; reason: string }
