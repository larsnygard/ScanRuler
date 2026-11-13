// SPDX-License-Identifier: AGPL-3.0-only
// The frames a CAD part stands in: the six named datum planes, a placement
// as a rotation and a move, and the reading of a picked point back onto a
// plane's sketch coordinates. All pure: no kernel, no DOM, Node-testable.
//
// A plane is an origin, an x axis and a normal: the sketch frame the
// sketch2d's geometry lives in, its y being the normal crossed into x. The
// extrude direction is the normal, flipped when the depth is negative — so
// a pocket is a negative depth, not a new plane.

import type { Vec3 } from '../../../src/core/types'
import type { DatumPlane, Placement, Plane } from './types'

/** The part's unit vectors. */
export const ORIGIN: Vec3 = [0, 0, 0]
export const X: Vec3 = [1, 0, 0]
export const Y: Vec3 = [0, 1, 0]
export const Z: Vec3 = [0, 0, 1]

/** The six faces of the part's box, as planes through the origin: the
 *  suffix names which way the normal points, `xy` the plane spanned by X
 *  and Y with its normal along +Z, `yx` the same span and its normal
 *  along +Y — the plane you sketch on when you look along −Z, and so on. */
export const DATUM_PLANES: Record<DatumPlane, Plane> = {
  xy: { origin: ORIGIN, xAxis: X, zAxis: Z },
  yx: { origin: ORIGIN, xAxis: X, zAxis: Y },
  xz: { origin: ORIGIN, xAxis: X, zAxis: [0, 0, -1] },
  zx: { origin: ORIGIN, xAxis: Z, zAxis: X },
  yz: { origin: ORIGIN, xAxis: Y, zAxis: Z },
  zy: { origin: ORIGIN, xAxis: Z, zAxis: Y },
}

export const datumPlane = (name: DatumPlane): Plane => DATUM_PLANES[name]

/** The plane through a body's own box, named by the axis its normal runs
 *  along: the face of the part's bounding box an extrude is sketched on
 *  when a feature sits on top of a feature. */
export function topPlane(name: DatumPlane, box: { min: Vec3; max: Vec3 }): Plane {
  const p = datumPlane(name)
  const at = (axis: 0 | 1 | 2) => box.max[axis]
  switch (name) {
    case 'xy':
    case 'xz':
      return { ...p, origin: [0, 0, at(2)] as Vec3 }
    case 'yx':
    case 'yz':
      return { ...p, origin: [0, at(1), 0] as Vec3 }
    case 'zx':
    case 'zy':
      return { ...p, origin: [at(0), 0, 0] as Vec3 }
  }
}

/** The frame a sketch stands in when it is drawn on a plane pushed out
 *  from the datum by `offset` along its normal, moved by `shift` in its
 *  own x and y. */
export function sketchPlane(name: DatumPlane, box: { min: Vec3; max: Vec3 } | null, offset: number, shift: [number, number] = [0, 0]): Plane {
  const base = box ? topPlane(name, box) : datumPlane(name)
  const y = yOf(base)
  const o = base.origin
  return {
    origin: [o[0] + base.zAxis[0] * offset + base.xAxis[0] * shift[0] + y[0] * shift[1], o[1] + base.zAxis[1] * offset + base.xAxis[1] * shift[0] + y[1] * shift[1], o[2] + base.zAxis[2] * offset + base.xAxis[2] * shift[0] + y[2] * shift[1]],
    xAxis: base.xAxis,
    zAxis: base.zAxis,
  }
}

/** The plane's y: normal crossed into x. */
export function yOf(p: Plane): Vec3 {
  const [ax, ay, az] = p.xAxis
  const [zx, zy, zz] = p.zAxis
  return [zy * az - zz * ay, zz * ax - zx * az, zx * ay - zy * ax]
}

/** Where a 3D point lies in the plane's sketch coordinates. */
export function toSketch(p: Plane, at: Vec3): [number, number] {
  const y = yOf(p)
  const d: Vec3 = [at[0] - p.origin[0], at[1] - p.origin[1], at[2] - p.origin[2]]
  return [d[0] * p.xAxis[0] + d[1] * p.xAxis[1] + d[2] * p.xAxis[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]]
}

/** Where a sketch point stands in the part. */
export function toPart(p: Plane, at: [number, number]): Vec3 {
  const y = yOf(p)
  return [p.origin[0] + p.xAxis[0] * at[0] + y[0] * at[1], p.origin[1] + p.xAxis[1] * at[0] + y[1] * at[1], p.origin[2] + p.xAxis[2] * at[0] + y[2] * at[1]]
}

/** The identity placement. */
export const IDENTITY: Placement = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] }

/** Turn about an axis through the origin, right-handed, radians. */
export function rotationAbout(axis: Vec3, angle: number): number[] {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  return [
    c + x * x * t,
    x * y * t - z * s,
    x * z * t + y * s,
    y * x * t + z * s,
    c + y * y * t,
    y * z * t - x * s,
    z * x * t - y * s,
    z * y * t + x * s,
    c + z * z * t,
  ]
}

/** A placement moved by `at` and turned by `rot`, composed onto the one
 *  in hand: what a component's placement grows by when a pattern repeats
 *  it, feature upon feature. */
export function compose(a: Placement, b: Placement): Placement {
  const r = mat3(a.rotation, b.rotation)
  const t: Vec3 = apply3(a.rotation, b.translation)
  return { rotation: r, translation: [t[0] + a.translation[0], t[1] + a.translation[1], t[2] + a.translation[2]] }
}

/** A placement applied to a point. */
export function apply(placement: Placement, at: Vec3): Vec3 {
  return [
    placement.rotation[0] * at[0] + placement.rotation[1] * at[1] + placement.rotation[2] * at[2] + placement.translation[0],
    placement.rotation[3] * at[0] + placement.rotation[4] * at[1] + placement.rotation[5] * at[2] + placement.translation[1],
    placement.rotation[6] * at[0] + placement.rotation[7] * at[1] + placement.rotation[8] * at[2] + placement.translation[2],
  ]
}

/** The extrude's depth as a vector in the part: the plane's normal times
 *  the depth (negative depth cutting into the material behind it). */
export function extrudeVector(p: Plane, depth: number): Vec3 {
  return [p.zAxis[0] * depth, p.zAxis[1] * depth, p.zAxis[2] * depth]
}

function mat3(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return out
}

function apply3(m: number[], v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/** A 3×3 rotation read as Euler angles about X, then Y, then Z — what the
 *  panel shows a component's placement as. */
export function toEuler(rotation: number[]): [number, number, number] {
  const sy = Math.hypot(rotation[0], rotation[3])
  const singular = sy < 1e-6
  // R = Rz·Ry·Rx read back: y from R20, x from R21/R22, z from R10/R00.
  // At the gimbal (y = ±90°) x and z share one axis: x is set to zero and
  // the spin read from R01/R11.
  const x = singular ? 0 : Math.atan2(rotation[7], rotation[8])
  const y = Math.atan2(-rotation[6], sy)
  const z = singular ? Math.atan2(-rotation[1], rotation[4]) : Math.atan2(rotation[3], rotation[0])
  return [x, y, z]
}

/** Euler angles about X, Y, Z, as the panel takes them, back to a matrix. */
export function fromEuler(x: number, y: number, z: number): number[] {
  const rx = rotationAbout([1, 0, 0], x)
  const ry = rotationAbout([0, 1, 0], y)
  const rz = rotationAbout([0, 0, 1], z)
  return mat3(mat3(rz, ry), rx)
}
