// SPDX-License-Identifier: AGPL-3.0-only
// Everything the CAD workspace knows. The part is the feature list — the
// list alone is the part, and the list is what a project file saves. Every
// change to it asks for a build; the build settles it (a sketch's
// constraints solve) and compiles it, and what stands is drawn.
//
// The store holds the list, the build's outcome, and what the panel is at.
// The building itself is the session's (app/cadSession.ts): the store is
// asked to change, and the change is the store's; the build is what the
// change means.

import { create } from 'zustand'
import type { BuildResult, Feature } from '../core/part'
import { newBox } from '../core/part'
import type { BuiltShape } from '../core/types'
import type { DrawProfile } from '../core/protocol'

/** What the workspace is doing. */
export type CadStatus = 'idle' | 'building' | 'ready' | 'failed'

/** A body of the last build. */
export interface CadBody extends BuiltShape {}

/** The features a panel offers to add, each a fresh id given on add. */
export type CadTool = 'box' | 'cylinder' | 'sphere' | 'sketch' | 'extrude' | 'boolean' | 'fillet' | 'chamfer' | 'shell' | 'pattern' | 'mirror' | 'loft' | 'revolve' | 'import'

interface CadState {
  /** The part: the feature list, in build order. */
  features: Feature[]
  /** The part titled. */
  name: string
  /** What the last build did, one per feature. */
  results: BuildResult[]
  /** The bodies it left, by feature id. */
  bodies: Map<number, CadBody>
  /** The sketches it settled, by feature id. */
  profiles: Map<number, DrawProfile>
  status: CadStatus
  /** What a build in play is at (its feature, named), last told. */
  step: string | null
  /** What the last build said, when it had a word for it. */
  message: string | null
  /** The feature the panel has selected, say to fillet an edge of it. */
  selected: number | null
  /** A body clicked in the viewport, told to the tool in hand (a fillet
   *  names the edge nearest the click): the session sets this, the panel's
   *  tool takes it. */
  pickPoint: ((id: number, point: [number, number, number]) => void) | null
  /** The tool in hand, adding a feature. */
  tool: CadTool | null
  /** The feature last changed — the panel opens it. */
  editing: number | null
  /** The kernel let go (reset, or a worker that died): the next build
   *  loads it again. */
  kernelGone: boolean
  /** The bodies put away as a whole (the view bar's key, view.set), and
   *  the sketches: hidden in the viewport, kept in the part. */
  bodiesHidden: boolean
  sketchesHidden: boolean

  setFeatures(next: Feature[]): void
  setName(name: string): void
  setResults(results: BuildResult[], bodies: CadBody[], profiles: DrawProfile[], ok: boolean, message: string | null): void
  setStatus(status: CadStatus, step?: string | null): void
  setSelected(id: number | null): void
  setPickPoint(fn: ((id: number, point: [number, number, number]) => void) | null): void
  setTool(tool: CadTool | null): void
  setEditing(id: number | null): void
  setKernelGone(gone: boolean): void
  setBodiesHidden(hidden: boolean): void
  setSketchesHidden(hidden: boolean): void
}

export const CAD_SETTINGS = ['name'] as const

/** The part a workspace starts with: nothing. A scan loaded beside a CAD
 *  part is drawn as it is; the part is built from the first feature. */
export function emptyFeatures(): Feature[] {
  return []
}

/** The part a workspace starts with, from the panel: one box, 40 × 30 ×
 *  20 mm, standing on the datum's origin. */
export function starterFeatures(): Feature[] {
  return [newBox(0)]
}

export const useCad = create<CadState>((set) => ({
  features: emptyFeatures(),
  name: 'part',
  results: [],
  bodies: new Map(),
  profiles: new Map(),
  status: 'idle',
  step: null,
  message: null,
  selected: null,
  pickPoint: null,
  tool: null,
  editing: null,
  kernelGone: false,
  bodiesHidden: false,
  sketchesHidden: false,

  setFeatures: (features) => set({ features }),
  setName: (name) => set({ name }),
  setResults: (results, bodies, profiles, ok, message) =>
    set({
      results,
      bodies: new Map(bodies.map((b) => [b.id, b])),
      profiles: new Map(profiles.map((p) => [p.id, p])),
      status: ok ? 'ready' : 'failed',
      step: null,
      message,
    }),
  setStatus: (status, step = null) => set({ status, step }),
  setSelected: (selected) => set({ selected }),
  setPickPoint: (pickPoint) => set({ pickPoint }),
  setTool: (tool) => set({ tool }),
  setEditing: (editing) => set({ editing }),
  setKernelGone: (kernelGone) => set({ kernelGone }),
  setBodiesHidden: (bodiesHidden) => set({ bodiesHidden }),
  setSketchesHidden: (sketchesHidden) => set({ sketchesHidden }),
}))

/** The features a panel adds get their ids past every id in the list:
 *  the list is the state, and a feature's id is its place in it. */
export function nextId(features: Feature[]): number {
  let top = -1
  for (const f of features) top = Math.max(top, f.id)
  return top + 1
}

