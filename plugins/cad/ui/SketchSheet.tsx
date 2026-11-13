// SPDX-License-Identifier: AGPL-3.0-only
// The sheet a CAD sketch is edited on: the sketch's plane laid flat, its
// grid and axes, every entity drawn from its points, the points as handles
// a drag moves — solved about the constraints as the drag goes — the tools
// that draw lines, circles, arcs and rectangles, and the relation keys
// that constrain what is selected. It is the panel's editor for one
// sketch feature; the store (state/sketchStore.ts) holds the working copy
// and the selection, the geometry operations are core/sketchEdit.ts, and
// Done writes the sheet back into the feature list — the build settles it.
//
// The sheet is an SVG that maps the sketch's millimetres to pixels about a
// fitted view (y is up, as the sketch's own axes are). The pointer is read
// in sheet millimetres; a click near an existing vertex snaps to it, and
// dropping a dragged point on one welds it.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactElement } from 'react'
import { Icon, type IconName } from '../../../src/ui/icons'
import { useSketch, emptySelection, type SketchSelection } from '../state/sketchStore'
import { entityPolyline } from '../core/sketch2d'
import { addConstraint, deleteEntity, dist2, guessConstraints, movePoint, nearestVertex, removeConstraint, sketchPoints, weldPoint, type Point2, type SketchDoc } from '../core/sketchEdit'
import { useCad } from '../state/cadStore'
import type { SketchEntity } from '../core/types'
import type { Constraint } from '../core/solver2d'
import '../ui/cad.css'

/** A click this many pixels from a vertex lands on it. */
const SNAP_PX = 7

const TOOLS: { id: 'select' | 'line' | 'circle' | 'arc' | 'rectangle'; icon: IconName; label: string; title: string; key: string }[] = [
  { id: 'select', icon: 'navigate', label: 'Select', title: 'Click an entity to select it, a point to select that. Drag a point to move it — the constraints move the rest with it, and dropping it on a vertex welds them to one. Shift-click adds to the selection', key: 'v' },
  { id: 'line', icon: 'line', label: 'Line', title: 'Click the start, then each next corner — the chain carries on. A click on a vertex snaps and welds. Enter, Escape, or a click on the last point ends the chain', key: 'l' },
  { id: 'circle', icon: 'circle', label: 'Circle', title: 'Click the centre, then a point on the rim', key: 'c' },
  { id: 'arc', icon: 'arc', label: 'Arc', title: 'Click the centre, the start, then where it ends — counter-clockwise between', key: 'a' },
  { id: 'rectangle', icon: 'rectangle', label: 'Rectangle', title: 'Press on one corner and drag to the opposite: four lines with the corners welded and the sides held to the axes', key: 'r' },
]

const RELATIONS: { kind: Constraint['kind']; label: string; title: string; takes: (s: SketchSelection, entities: SketchEntity[]) => boolean }[] = [
  { kind: 'coincident', label: 'Coincident', title: 'Two selected points become one (1)', takes: (s) => s.points.length === 2 },
  { kind: 'horizontal', label: 'Horizontal', title: 'A selected line lies along X (2)', takes: (s, es) => s.entities.length === 1 && es[s.entities[0]]?.kind === 'line' },
  { kind: 'vertical', label: 'Vertical', title: 'A selected line lies along Y (3)', takes: (s, es) => s.entities.length === 1 && es[s.entities[0]]?.kind === 'line' },
  { kind: 'parallel', label: 'Parallel', title: 'Two selected lines run the same way (4)', takes: (s, es) => s.entities.length === 2 && s.entities.every((i) => es[i]?.kind === 'line') },
  { kind: 'perpendicular', label: 'Square', title: 'Two selected lines at right angles (5)', takes: (s, es) => s.entities.length === 2 && s.entities.every((i) => es[i]?.kind === 'line') },
  { kind: 'equal-distance', label: 'Equal', title: 'Two selected lines share their length (6)', takes: (s, es) => s.entities.length === 2 && s.entities.every((i) => es[i]?.kind === 'line') },
]

export function SketchSheet() {
  const openId = useSketch((s) => s.openId)
  const draft = useSketch((s) => s.draft)
  const tool = useSketch((s) => s.tool)
  const selection = useSketch((s) => s.selection)
  const chainFrom = useSketch((s) => s.chainFrom)
  const setDraft = useSketch((s) => s.setDraft)
  const setSelection = useSketch((s) => s.setSelection)
  const setChainFrom = useSketch((s) => s.setChainFrom)
  const setTool = useSketch((s) => s.setTool)
  const commit = useSketch((s) => s.commit)
  const close = useSketch((s) => s.close)
  const sketch = useCad((s) => s.features.find((f) => f.id === openId))
  const planeName = sketch && sketch.kind === 'sketch' ? sketch.plane.toUpperCase() : ''

  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 640, h: 480 })
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    el.focus()
    return () => ro.disconnect()
  }, [openId])

  // The view: the sketch's bounds fitted with a margin, a fixed minimum,
  // so a dot of a sketch is not a page of grid.
  const view = useMemo(() => {
    let minX = -20, maxX = 20, minY = -20, maxY = 20
    if (draft)
      for (const e of draft.entities) {
        const pts: Point2[] =
          e.kind === 'line'
            ? [e.from, e.to]
            : e.kind === 'circle'
              ? [
                  [e.center[0] - e.radius, e.center[1] - e.radius],
                  [e.center[0] + e.radius, e.center[1] + e.radius],
                ]
              : entityPolyline(e)
        for (const [x, y] of pts) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
      }
    const margin = 0.18
    const bw = Math.max(maxX - minX, 1e-3)
    const bh = Math.max(maxY - minY, 1e-3)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const halfW = (bw / 2) * (1 + margin) + 1
    const halfH = (bh / 2) * (1 + margin) + 1
    const s = Math.min(size.w / (2 * halfW), size.h / (2 * halfH), 40)
    return { cx, cy, s }
  }, [draft, size])

  const toPx = (p: Point2): [number, number] => [size.w / 2 + (p[0] - view.cx) * view.s, size.h / 2 - (p[1] - view.cy) * view.s]
  const toMm = (ev: { clientX: number; clientY: number }): Point2 => {
    const r = (hostRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }) as DOMRect
    return [(ev.clientX - r.left - size.w / 2) / view.s + view.cx, -(ev.clientY - r.top - size.h / 2) / view.s + view.cy]
  }
  const snapTol = SNAP_PX / view.s

  // Pointer state: a drag of a point, the rectangle being pulled, the arc
  // clicks taken so far, the cursor for the drawing previews.
  const dragRef = useRef<{ point: number; moved: boolean } | null>(null)
  const rectRef = useRef<{ from: Point2 } | null>(null)
  const arcRef = useRef<{ center: Point2; from: Point2 | null } | null>(null)
  const [cursor, setCursor] = useState<Point2 | null>(null)

  if (openId === null || !draft) return null

  const points = sketchPoints(draft.entities)
  const selectedEntity = new Set(selection.entities)
  const selectedPoint = new Set(selection.points)

  const entityPoints = (i: number): number[] => {
    const base = points.find((p) => p.entity === i)
    if (!base) return []
    const count = draft.entities[i].kind === 'line' ? 2 : draft.entities[i].kind === 'circle' ? 2 : draft.entities[i].kind === 'arc' ? 3 : (draft.entities[i] as { points: Point2[] }).points.length
    return Array.from({ length: count }, (_, k) => base.index + k)
  }

  const snap = (at: Point2): { at: Point2; vertex: number | null } => {
    const v = nearestVertex(draft.entities, at, snapTol)
    return v ? { at: v.at, vertex: v.index } : { at, vertex: null }
  }

  const onPointerDown = (ev: RPointerEvent) => {
    if (!draft) return
    const at = toMm(ev)
    ev.currentTarget.setPointerCapture(ev.pointerId)
    if (tool === 'select') {
      const s = snap(at)
      if (s.vertex !== null) {
        dragRef.current = { point: s.vertex, moved: false }
        setSelection({ entities: [], points: [s.vertex], constraints: [] })
      } else {
        // The entity whose polyline this is, the closest within a few px.
        let best = -1
        let bestD = 6 / view.s
        draft.entities.forEach((e, i) => {
          const pts = entityPolylineOf(e)
          for (let k = 0; k + 1 < pts.length; k++) {
            const d = distToSegment(at, pts[k], pts[k + 1])
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        })
        if (best >= 0) {
          const pts = entityPoints(best)
          const add = ev.shiftKey || ev.ctrlKey || ev.metaKey
          const entities = add ? [...new Set([...selection.entities, best])] : [best]
          const selPoints = add ? [...new Set([...selection.points, ...pts])] : pts
          setSelection({ entities, points: selPoints, constraints: [] })
        } else if (!ev.shiftKey) setSelection(emptySelection())
      }
      return
    }
    if (tool === 'rectangle') {
      rectRef.current = { from: snap(at).at }
      return
    }
  }

  const onPointerMove = (ev: RPointerEvent) => {
    const at = toMm(ev)
    setCursor(at)
    const drag = dragRef.current
    if (drag && draft) {
      const s = snap(at)
      const moved = movePoint(draft, drag.point, s.at)
      drag.moved = true
      setDraft(moved.doc)
    }
  }

  const onPointerUp = (ev: RPointerEvent) => {
    const at = toMm(ev)
    const drag = dragRef.current
    if (drag && draft) {
      const s = snap(at)
      if (s.vertex !== null && s.vertex !== drag.point) {
        setDraft(weldPoint(draft, drag.point, s.vertex))
      }
      dragRef.current = null
      return
    }
    if (rectRef.current && draft) {
      const a = rectRef.current.from
      const b = snap(at).at
      rectRef.current = null
      if (dist2(a, b) < snapTol) return
      const len = draft.entities.length
      setDraft(rectangleDoc(draft, a, b).doc)
      setSelection({ entities: [len, len + 1, len + 2, len + 3], points: [], constraints: [] })
      return
    }
  }

  const onClick = (ev: RMouseEvent) => {
    if (!draft) return
    const at = toMm(ev)
    if (tool === 'select') return
    if (tool === 'rectangle') return
    const s = snap(at)
    if (tool === 'line') {
      if (chainFrom === null) {
        setChainFrom(s.at)
        return
      }
      const base = points.length
      const doc = { entities: [...draft.entities, { kind: 'line', from: chainFrom, to: s.at } as SketchEntity], constraints: draft.constraints }
      setDraft(s.vertex !== null ? weldPoint(doc, base + 1, s.vertex) : doc)
      setChainFrom(s.at)
      return
    }
    if (tool === 'circle') {
      if (chainFrom === null) {
        setChainFrom(s.at)
        return
      }
      const center = chainFrom
      setChainFrom(null)
      const radius = Math.max(1e-3, dist2(center, s.at))
      const doc = { entities: [...draft.entities, { kind: 'circle', center, radius } as SketchEntity], constraints: draft.constraints }
      setDraft(s.vertex !== null ? weldPoint(doc, sketchPoints(draft.entities).length + 1, s.vertex) : doc)
      return
    }
    if (tool === 'arc') {
      if (!arcRef.current) {
        arcRef.current = { center: s.at, from: null }
        setChainFrom(s.at)
        return
      }
      if (arcRef.current.from === null) {
        arcRef.current = { center: arcRef.current.center, from: s.at }
        setChainFrom(s.at)
        return
      }
      const center = arcRef.current.center
      const from = arcRef.current.from
      const radius = Math.max(1e-3, dist2(center, from))
      const to = s.at
      const e: SketchEntity = { kind: 'arc', center, radius, fromAngle: Math.atan2(from[1] - center[1], from[0] - center[0]), toAngle: Math.atan2(to[1] - center[1], to[0] - center[0]) }
      arcRef.current = null
      setChainFrom(null)
      setDraft({ entities: [...draft.entities, e], constraints: draft.constraints })
    }
  }

  const onDoubleClick = () => setChainFrom(null)

  const applyRelation = (kind: Constraint['kind']) => {
    if (!draft) return
    let c: Constraint | null = null
    const [p1, p2] = selection.points
    const [e1, e2] = selection.entities
    const baseOf = (i: number) => points.find((p) => p.entity === i)!.index
    if (kind === 'coincident' && selection.points.length === 2) c = { kind: 'coincident', a: p1, b: p2 }
    else if (kind === 'horizontal' && e1 !== undefined) c = { kind: 'horizontal', a: baseOf(e1), b: baseOf(e1) + 1 }
    else if (kind === 'vertical' && e1 !== undefined) c = { kind: 'vertical', a: baseOf(e1), b: baseOf(e1) + 1 }
    else if (kind === 'parallel' && e1 !== undefined && e2 !== undefined) c = { kind: 'parallel', a1: baseOf(e1), b1: baseOf(e1) + 1, a2: baseOf(e2), b2: baseOf(e2) + 1 }
    else if (kind === 'perpendicular' && e1 !== undefined && e2 !== undefined) c = { kind: 'perpendicular', a1: baseOf(e1), b1: baseOf(e1) + 1, a2: baseOf(e2), b2: baseOf(e2) + 1 }
    else if (kind === 'equal-distance' && e1 !== undefined && e2 !== undefined) c = { kind: 'equal-distance', a1: baseOf(e1), b1: baseOf(e1) + 1, a2: baseOf(e2), b2: baseOf(e2) + 1 }
    if (c) setDraft(addConstraint(draft, c))
  }

  const fixSelected = () => {
    if (!draft) return
    for (const p of selection.points) setDraft(addConstraint(draft, { kind: 'fixed', a: p }))
  }

  const removeSel = () => {
    if (!draft) return
    let doc: SketchDoc = draft
    for (const i of [...selection.entities].sort((a, b) => b - a)) doc = deleteEntity(doc, i)
    for (const i of [...selection.constraints].sort((a, b) => b - a)) doc = removeConstraint(doc, i)
    setDraft(doc)
    setSelection(emptySelection())
  }

  const keysDown = (ev: RKeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      commit()
      return
    }
    if (ev.key === 'Escape') {
      ev.preventDefault()
      if (chainFrom) setChainFrom(null)
      else if (selection.entities.length || selection.points.length) setSelection(emptySelection())
      else close()
      return
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault()
      removeSel()
      return
    }
    const t = TOOLS.find((t) => t.key === ev.key.toLowerCase())
    if (t) {
      setTool(t.id)
      return
    }
    if (ev.key >= '1' && ev.key <= '6') {
      const r = RELATIONS[Number(ev.key) - 1]
      if (r && r.takes(selection, draft?.entities ?? [])) applyRelation(r.kind)
    }
    if (ev.key.toLowerCase() === 'f' && selection.points.length > 0) fixSelected()
  }

  // The drawing grid: lines at a readable millimetre pitch, axes heavier.
  const gridStep = useMemo(() => {
    const target = 60 / view.s
    const pow = 10 ** Math.floor(Math.log10(target))
    return [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= target) ?? pow * 10
  }, [view.s])

  const grid = useMemo(() => {
    const { cx, cy, s } = view
    const half = Math.max(size.w, size.h) / (2 * s)
    const lines: ReactElement[] = []
    const x0 = Math.floor((cx - half) / gridStep) * gridStep
    const y0 = Math.floor((cy - half) / gridStep) * gridStep
    const top = (cy + half)
    const right = (cx + half)
    for (let x = x0; x <= right; x += gridStep) {
      const [px] = toPx([x, 0])
      lines.push(<line key={`gx${x}`} x1={px} y1={0} x2={px} y2={size.h} className={Math.abs(x) < 1e-9 ? 'cad-sk-axis' : 'cad-sk-grid'} />)
    }
    for (let y = y0; y <= top; y += gridStep) {
      const [, py] = toPx([0, y])
      lines.push(<line key={`gy${y}`} x1={0} y1={py} x2={size.w} y2={py} className={Math.abs(y) < 1e-9 ? 'cad-sk-axis' : 'cad-sk-grid'} />)
    }
    return lines
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size, gridStep])

  const drawn = draft.entities.map((e, i) => {
    const pts = entityPolylineOf(e)
    const poly = pts.map((p) => toPx(p).join(',')).join(' ')
    const on = selectedEntity.has(i)
    return <polyline key={`e${i}`} points={poly} className={`cad-sk-ent${on ? ' on' : ''}`} fill="none" />
  })

  const handles = points.map((p) => {
    const [x, y] = toPx(p.at)
    const on = selectedPoint.has(p.index)
    return <rect key={`p${p.index}`} x={x - 3.5} y={y - 3.5} width={7} height={7} className={`cad-sk-point${on ? ' on' : ''}`} />
  })

  // The preview: the line chain, the circle, the rectangle, the arc, as
  // the cursor moves.
  let preview: ReactElement | null = null
  if (cursor && tool !== 'select') {
    if (tool === 'line' && chainFrom) {
      const s = snap(cursor)
      const [x1, y1] = toPx(chainFrom)
      const [x2, y2] = toPx(s.at)
      preview = <line x1={x1} y1={y1} x2={x2} y2={y2} className="cad-sk-pre" />
    } else if (tool === 'circle' && chainFrom) {
      const [cx, cy] = toPx(chainFrom)
      const [px, py] = toPx(snap(cursor).at)
      preview = <circle cx={cx} cy={cy} r={Math.hypot(px - cx, py - cy)} className="cad-sk-pre" fill="none" />
    } else if (tool === 'rectangle' && rectRef.current) {
      const a = rectRef.current.from
      const b = snap(cursor).at
      const [x1, y1] = toPx(a)
      const [x2, y2] = toPx(b)
      preview = <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} className="cad-sk-pre" fill="none" />
    } else    if (tool === 'arc' && arcRef.current) {
      const center = arcRef.current.center
      if (arcRef.current.from === null) {
        const [cx, cy] = toPx(center)
        const [px, py] = toPx(snap(cursor).at)
        preview = <circle cx={cx} cy={cy} r={Math.hypot(px - cx, py - cy)} className="cad-sk-pre" fill="none" />
      } else {
        const from = arcRef.current.from
        const to = snap(cursor).at
        const r = Math.max(1e-3, dist2(center, from)) * view.s
        const a0 = Math.atan2(from[1] - center[1], from[0] - center[0])
        const a1 = Math.atan2(to[1] - center[1], to[0] - center[0])
        let d = a1 - a0
        while (d < 0) d += 2 * Math.PI
        const large = d > Math.PI ? 1 : 0
        const [sx, sy] = toPx(from)
        const [ex, ey] = toPx(to)
        preview = <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${large} 0 ${ex} ${ey}`} className="cad-sk-pre" fill="none" />
      }
    }
  }
  // A snap lights the vertex a click lands on.
  const snapLight: ReactElement | null =
    cursor && tool !== 'select'
      ? (() => {
          const v = nearestVertex(draft.entities, cursor, snapTol)
          if (!v) return null
          const [x, y] = toPx(v.at)
          return <circle cx={x} cy={y} r={6} className="cad-sk-snap" fill="none" />
        })()
      : null

  const done = () => commit()

  return (
    <div className="cad-sketch-stage" tabIndex={0} onKeyDown={keysDown} ref={hostRef} data-test="cad-sketch-stage">
      <div className="cad-sketch-bar">
        <span className="cad-sketch-title" data-test="cad-sketch-title">
          Sketch · {planeName}
        </span>
        <div className="cad-sketch-tools" role="toolbar" aria-label="Sketch tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`icobtn${tool === t.id ? ' on' : ''}`} title={t.title} aria-label={t.label} onClick={() => setTool(t.id)}>
              <Icon name={t.icon} />
            </button>
          ))}
        </div>
        <div className="cad-sketch-relations" role="toolbar" aria-label="Relations">
          {RELATIONS.map((r) => (
            <button key={r.kind} className="btn small" disabled={!r.takes(selection, draft.entities)} title={`${r.title}`} onClick={() => applyRelation(r.kind)}>
              {r.label}
            </button>
          ))}
          <button className="btn small" disabled={selection.points.length === 0} title="Pin the selected points where they lie (f)" onClick={fixSelected}>
            Fix
          </button>
          <button
            className="btn small"
            title="Read the drawing back as constraints: welded ends, axis-aligned sides, a start on the origin"
            onClick={() => setDraft(guessConstraints(draft).doc)}
          >
            Infer
          </button>
          <button className="btn small" disabled={selection.entities.length === 0 && selection.constraints.length === 0} title="Delete the selection (Del)" onClick={removeSel}>
            Delete
          </button>
        </div>
        <button className="btn small primary" onClick={done} data-test="cad-sketch-done">
          Done
        </button>
        <button className="btn small" title="Leave the sheet without writing (Escape)" onClick={() => close()}>
          Cancel
        </button>
      </div>
      <svg
        className="cad-sketch-sheet"
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
      >
        {grid}
        {drawn}
        {preview}
        {snapLight}
        {handles}
      </svg>
      <div className="cad-sketch-foot">
        <span>
          {draft.entities.length} pieces · {draft.constraints.length} constraints
        </span>
        <span className="hint">
          {selection.entities.length ? `${selection.entities.length} selected` : selection.points.length ? 'point selected' : tool === 'select' ? 'Click a piece, drag a point' : `Click to place${chainFrom ? ' — the next point' : ''}`}
        </span>
      </div>
    </div>
  )
}

/** An entity as points to draw: lines straight, circles and arcs
 *  tessellated, splines through their fit points (a closed spline
 *  wrapped back to its start). */
function entityPolylineOf(e: SketchEntity): Point2[] {
  if (e.kind === 'spline' && e.closed) return [...e.points, e.points[0]]
  return entityPolyline(e)
}

function distToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const n = dx * dx + dy * dy
  if (n === 0) return dist2(p, a)
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n))
  return dist2(p, [a[0] + t * dx, a[1] + t * dy])
}

function rectangleDoc(doc: SketchDoc, a: Point2, b: Point2): { doc: SketchDoc; base: number } {
  // The corners, counter-clockwise from (a.x, a.y) — the sign of the
  // edges is taken care of by the corners themselves, not by the order.
  const corners: Point2[] = [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ]
  return rectangleBetween(doc, corners)
}

function rectangleBetween(doc: SketchDoc, corners: Point2[]): { doc: SketchDoc; base: number } {
  const base = sketchPoints(doc.entities).length
  const entities = [...doc.entities]
  for (let k = 0; k < 4; k++) entities.push({ kind: 'line', from: corners[k], to: corners[(k + 1) % 4] })
  let out: SketchDoc = { entities, constraints: doc.constraints }
  for (let k = 0; k < 4; k++) out = weldPoint(out, base + ((2 * (k + 1)) % 8), base + 2 * k + 1)
  for (let k = 0; k < 4; k++) out = addConstraint(out, k % 2 === 0 ? { kind: 'horizontal', a: base + 2 * k, b: base + 2 * k + 1 } : { kind: 'vertical', a: base + 2 * k, b: base + 2 * k + 1 })
  return { doc: out, base }
}
