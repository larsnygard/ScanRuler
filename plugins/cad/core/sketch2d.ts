// SPDX-License-Identifier: AGPL-3.0-only
// The sketch's 2D geometry: entities closed into loops, loops sorted into an
// outline and its holes, and the two turned into the wires a face and an
// extrude are built from. A sketch is drawn in its own plane's millimetres;
// everything here is in that flat frame — the plane's axes belong to the
// kernel's side (kernel.ts), which lifts a loop back into 3D.
//
// What a sketch's entities form is decided by its endpoints: two line ends
// that meet (within a tolerance) are the same vertex, an arc's ends join
// lines the same way, a full circle stands as a loop of its own. A loop of
// lines and arcs is walked, its signed area says which way it winds, and
// loops inside loops are holes — the outermost, by their bounding boxes.

import type { SketchEntity } from './types'

/** Two points this far apart are one. A tenth of a micron over parts of a
 *  few hundred millimetres: the person's grid snaps leave far more, and the
 *  solver settles to less. */
export const WELD_TOL = 1e-4

/** A closed polyline as [x, y] pairs, and the area it encloses (positive
 *  counter-clockwise). */
export interface Loop2D {
  points: [number, number][]
  area: number
}

export interface Point2D {
  x: number
  y: number
}

export const dist2 = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y)

export function polylineArea(points: [number, number][]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** Tessellate a circular arc to a polyline, its middle included; a span of
 *  a quarter turn or less stays a single chord. */
export function arcPolyline(center: Point2D, radius: number, fromAngle: number, toAngle: number): [number, number][] {
  let span = toAngle - fromAngle
  // Walk counter-clockwise from fromAngle, as the kernel's arcs do: a
  // negative span is taken the long way round.
  if (span < 0) span += 2 * Math.PI
  const steps = Math.max(1, Math.ceil((Math.abs(span) * radius) / 0.4))
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = fromAngle + (span * i) / steps
    out.push([center.x + radius * Math.cos(a), center.y + radius * Math.sin(a)])
  }
  return out
}

/** The endpoints an entity has, in the drawing's winding (from → to): lines
 *  and arcs two, a full circle none, a spline two (ends of its polyline). */
function ends(e: SketchEntity): { from: Point2D; to: Point2D } | null {
  switch (e.kind) {
    case 'line':
      return { from: { x: e.from[0], y: e.from[1] }, to: { x: e.to[0], y: e.to[1] } }
    case 'arc':
      return { from: { x: e.center[0] + e.radius * Math.cos(e.fromAngle), y: e.center[1] + e.radius * Math.sin(e.fromAngle) }, to: { x: e.center[0] + e.radius * Math.cos(e.toAngle), y: e.center[1] + e.radius * Math.sin(e.toAngle) } }
    case 'spline':
      if (e.closed || e.points.length < 2) return null
      return { from: { x: e.points[0][0], y: e.points[0][1] }, to: { x: e.points[e.points.length - 1][0], y: e.points[e.points.length - 1][1] } }
    case 'circle':
      return null
  }
}

/** Every entity as the polyline that approximates it (arcs tessellated;
 *  lines and splines as they stand). */
export function entityPolyline(e: SketchEntity): [number, number][] {
  switch (e.kind) {
    case 'line':
      return [e.from, e.to]
    case 'arc':
      return arcPolyline({ x: e.center[0], y: e.center[1] }, e.radius, e.fromAngle, e.toAngle)
    case 'circle':
      return arcPolyline({ x: e.center[0], y: e.center[1] }, e.radius, 0, 2 * Math.PI)
    case 'spline':
      return e.points
  }
}

/** The entities closed into loops: full circles stand alone; the open
 *  entities are walked by welded endpoints, from any entity to the next
 *  that begins where it ends. Entities that lead nowhere (dangling) are
 *  left out — a sketch mid-draw is the normal case for that. */
export function closeLoops(entities: SketchEntity[]): Loop2D[] {
  const loops: Loop2D[] = []
  const open: { e: SketchEntity; from: Point2D; to: Point2D; used: boolean }[] = []
  for (const e of entities) {
    if (e.kind === 'circle') {
      // A circle's own loop, wound counter-clockwise: the outline the
      // kernel wants, and positive area to match.
      const pts: [number, number][] = []
      const steps = Math.max(8, Math.ceil((2 * Math.PI * e.radius) / 0.6))
      for (let i = 0; i < steps; i++) {
        const a = (2 * Math.PI * i) / steps
        pts.push([e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)])
      }
      loops.push({ points: pts, area: Math.PI * e.radius * e.radius })
      continue
    }
    if (e.kind === 'spline' && e.closed) {
      const area = polylineArea(e.points)
      loops.push({ points: e.points.slice(), area })
      continue
    }
    const endsOf = ends(e)
    if (endsOf) open.push({ e, ...endsOf, used: false })
  }

  const welded = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y) <= WELD_TOL

  // Walk chains: seed from an unused entity, follow welded ends until back
  // to the chain's start.
  for (let seed = 0; seed < open.length; seed++) {
    if (open[seed].used) continue
    const chain: { pts: [number, number][]; head: Point2D; tail: Point2D } = {
      pts: entityPolyline(open[seed].e),
      head: open[seed].from,
      tail: open[seed].to,
    }
    open[seed].used = true
    let closedChain = welded(chain.head, chain.tail)
    for (let guard = 0; guard < open.length && !closedChain; guard++) {
      let found = -1
      for (let i = 0; i < open.length; i++) {
        if (open[i].used) continue
        if (welded(open[i].from, chain.tail)) {
          found = i
          break
        }
        if (welded(open[i].to, chain.tail)) {
          // Taken backwards: its polyline runs to-front.
          const poly = entityPolyline(open[i].e).slice().reverse()
          chain.pts.push(...poly.slice(1))
          chain.tail = open[i].from
          open[i].used = true
          found = -2
          break
        }
      }
      if (found === -2) {
        closedChain = welded(chain.head, chain.tail)
        continue
      }
      if (found < 0) break
      chain.pts.push(...entityPolyline(open[found].e).slice(1))
      chain.tail = open[found].to
      open[found].used = true
      closedChain = welded(chain.head, chain.tail)
    }
    if (!closedChain || chain.pts.length < 3) continue
    // Drop the closing duplicate.
    const pts = chain.pts.slice()
    if (pts.length > 1) {
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= WELD_TOL) pts.pop()
    }
    loops.push({ points: pts, area: polylineArea(pts) })
  }
  return loops
}

/** Loops sorted into one outline and its holes, per island: a loop lies in
 *  the hole-side of the loop whose box just contains it, and nesting runs
 *  outline, hole, outline… An island is the outline with its holes, and
 *  nested outlines of their own come back as islands. */
export interface Island {
  outline: Loop2D
  holes: Loop2D[]
}

function box(loop: Loop2D) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of loop.points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

const containsBox = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.minX <= b.minX && a.minY <= b.minY && a.maxX >= b.maxX && a.maxY >= b.maxY

export function islandsOf(loops: Loop2D[]): Island[] {
  // Winding made canonical: outlines counter-clockwise, holes clockwise —
  // what the kernel's face wants.
  const made = loops.map((l) => ({ ...l, points: l.area < 0 ? l.points.slice().reverse() : l.points, area: Math.abs(l.area) }))
  const boxes = made.map(box)
  // Depth: how many loops' boxes contain this one. The island's outline is
  // the loop at depth 0; at depth 1 its holes; at 2, a new outline.
  const depth = made.map((_, i) => made.reduce((n, _, j) => (j !== i && containsBox(boxes[j], boxes[i]) ? n + 1 : n), 0))
  const islands: Island[] = []
  for (let i = 0; i < made.length; i++) {
    if (depth[i] === 0) islands.push({ outline: made[i], holes: [] })
  }
  for (let i = 0; i < made.length; i++) {
    if (depth[i] === 1) {
      // Wound clockwise for a hole: reverse the canonical counter-clockwise.
      const hole = { ...made[i], points: made[i].points.slice().reverse(), area: -made[i].area }
      // The smallest depth-0 outline whose box contains this one — its island.
      let best: Island | null = null
      for (let j = 0; j < made.length; j++) {
        if (depth[j] !== 0 || !containsBox(boxes[j], boxes[i])) continue
        const isl = islands.find((x) => x.outline === made[j])
        if (isl && (!best || areaOf(isl.outline) < areaOf(best.outline))) best = isl
      }
      if (best) best.holes.push(hole)
    }
    // Depth 2+ (an outline inside a hole) stands as its own island: its
    // face is built as a separate solid, which is what a drawn
    // pad-inside-a-pocket wants.
    if (depth[i] === 2) islands.push({ outline: made[i], holes: [] })
  }
  return islands
}

const areaOf = (l: Loop2D) => Math.abs(l.area)

/** The area a sketch's entities enclose (outlines minus holes) — what a
 *  build reports before an extrude needs the kernel for. */
export function sketchArea(entities: SketchEntity[]): number {
  return islandsOf(closeLoops(entities)).reduce((sum, isl) => sum + Math.abs(isl.outline.area) + isl.holes.reduce((s, h) => s + h.area, 0), 0)
}
