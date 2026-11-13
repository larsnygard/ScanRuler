// SPDX-License-Identifier: AGPL-3.0-only
// The sketch editor's own store: which sketch is open on the sheet, what
// tool is in hand, what is selected, and the edits the panel and the
// commands make through it. The editor is the sketch feature read and
// written as a doc (core/sketchEdit.ts): the store holds the doc — its
// entities and constraints — while the sheet shows it, and `commit` writes
// the doc back into the feature list, which asks for a build the way every
// change to the list does.
//
// The doc is the working copy; the feature in the list is the truth. A
// draft opens from a feature (`open`), lives while the sheet is up, and
// lands by `commit` — the list feature is replaced whole, as the panel's
// fields replace it. Closing without committing throws the draft away.
// The sketch's points, planes and measures live in the doc; nothing here
// touches the kernel — the build that follows a commit settles the
// constraints, as every build does.

import { create } from 'zustand'
import type { Feature } from '../core/part'
import type { Constraint } from '../core/solver2d'
import type { SketchEntity } from '../core/types'
import { guessConstraints, rectangle, weldPoint, type Point2, type SketchDoc } from '../core/sketchEdit'
import { useCad } from './cadStore'

/** What the editor's cursor does: pick, drag, draw. */
export type SketchEditorTool = 'select' | 'line' | 'circle' | 'rectangle' | 'arc'

/** A selection in the draft: entity indexes and point indexes (solver
 *  order, what `cad.sketch_points` answers). */
export interface SketchSelection {
  entities: number[]
  points: number[]
  constraints: number[]
}

export const emptySelection = (): SketchSelection => ({ entities: [], points: [], constraints: [] })

interface SketchEditorState {
  /** The sketch feature being edited, by id; null for no sheet open. */
  openId: number | null
  /** The working copy. */
  draft: SketchDoc | null
  tool: SketchEditorTool
  selection: SketchSelection
  /** A line tool's chain: the last point clicked, in sheet millimetres;
   *  null for no chain. */
  chainFrom: Point2 | null
  /** How well the last solve settled (mm, worst constraint), told after a
   *  commit — the panel flags it. */
  residual: number | null
  unsatisfied: { kind: string; value: number }[]

  open(id: number): void
  close(discard?: boolean): void
  setTool(tool: SketchEditorTool): void
  setSelection(sel: SketchSelection): void
  setChainFrom(at: Point2 | null): void
  /** Replace the draft whole (the panel's tools, a command's edit). */
  setDraft(doc: SketchDoc): void
  addEntity(e: SketchEntity): void
  drawRectangle(cx: number, cy: number, w: number, h: number): void
  weld(index: number, onto: number): void
  constrain(c: Constraint): void
  removeSelected(): void
  infer(): void
  /** Write the draft into the feature list (one history step), and close
   *  the sheet. The build the list change asks for settles it. */
  commit(): boolean
}

/** The sketch feature a draft is made from, checked in. */
function sketchFeature(id: number): Extract<Feature, { kind: 'sketch' }> | null {
  const f = useCad.getState().features.find((x) => x.id === id)
  return f && f.kind === 'sketch' ? f : null
}

export const useSketch = create<SketchEditorState>((set, get) => ({
  openId: null,
  draft: null,
  tool: 'select',
  selection: emptySelection(),
  chainFrom: null,
  residual: null,
  unsatisfied: [],

  open: (id) => {
    const f = sketchFeature(id)
    if (!f) return
    set({ openId: id, draft: { entities: structuredClone(f.entities), constraints: structuredClone(f.constraints) }, tool: 'select', selection: emptySelection(), chainFrom: null, residual: null, unsatisfied: [] })
  },
  close: () => set({ openId: null, draft: null, tool: 'select', selection: emptySelection(), chainFrom: null }),
  setTool: (tool) => set({ tool, chainFrom: null }),
  setSelection: (selection) => set({ selection }),
  setChainFrom: (chainFrom) => set({ chainFrom }),
  setDraft: (draft) => set({ draft }),

  addEntity: (e) => {
    const d = get().draft
    if (!d) return
    set({ draft: { ...d, entities: [...d.entities, e] } })
  },
  drawRectangle: (cx, cy, w, h) => {
    const d = get().draft
    if (!d) return
    set({ draft: rectangle(d, cx, cy, w, h).doc })
  },
  weld: (index, onto) => {
    const d = get().draft
    if (!d) return
    set({ draft: weldPoint(d, index, onto) })
  },
  constrain: (c) => {
    const d = get().draft
    if (!d) return
    set({ draft: { entities: d.entities, constraints: [...d.constraints, c] } })
  },
  removeSelected: () => {
    const d = get().draft
    const s = get().selection
    if (!d) return
    const drop = new Set(s.constraints)
    const entities = d.entities.filter((_, i) => !s.entities.includes(i))
    // Points: each selected point drops its entity's slot? No — a point
    // alone (no entity) is not removed: entities own the points.
    set({
      draft: {
        entities,
        constraints: d.constraints.filter((_, i) => !drop.has(i)),
      },
      selection: emptySelection(),
    })
  },
  infer: () => {
    const d = get().draft
    if (!d) return
    set({ draft: guessConstraints(d).doc })
  },
  commit: () => {
    const { openId, draft } = get()
    if (openId === null || !draft) return false
    const f = sketchFeature(openId)
    if (!f) return false
    const features = useCad.getState().features.map((x): Feature => (x.id === openId && x.kind === 'sketch' ? { ...x, entities: draft.entities, constraints: draft.constraints } : x))
    useCad.getState().setFeatures(features)
    get().close()
    return true
  },
}))

/** The sheet is up: the store's own gate. */
export const sketchEditing = () => useSketch.getState().openId !== null
