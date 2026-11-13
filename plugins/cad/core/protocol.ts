// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace's requests of its kernel worker, typed. One module
// naming them, the service (service.ts) answering them beside the kernel
// — in the worker on the page, in this thread under Node (cadLocal.ts) —
// so a build and an export run the same code whoever asked.

import type { Vec3 } from '../../../src/core/types'
import type { BuildResult } from './part'
import type { Feature } from './part'
import type { BuiltShape } from './types'

export const CAD = 'cad'

/** A sketch's settled profile for drawing: outlines in sketch coordinates
 *  and the plane they lie on, in the part. */
export interface DrawProfile {
  id: number
  plane: { origin: Vec3; xAxis: Vec3; zAxis: Vec3 }
  outlines: { outline: [number, number][]; holes: [number, number][][] }[]
  residual: number
}

export interface CadOps {
  /** The feature list compiled in order: one result per feature, the
   *  bodies as meshes to draw, the sketches as profiles. */
  build: { payload: { features: Feature[]; deflection?: number }; result: { results: BuildResult[]; bodies: BuiltShape[]; profiles: DrawProfile[] } }
  /** The part (all bodies, or those named) as a file. */
  export: { payload: { format: 'step' | 'stl' | '3mf'; ids?: number[]; deflection?: number; name?: string }; result: { bytes: Uint8Array; name: string; mime: string } }
  /** Bytes in: a STEP or STL body, staged beside the part; its key names
   *  it to an imported feature. */
  stage: { payload: { bytes: Uint8Array; format: 'step' | 'stl' }; result: { key: number; closed: boolean } }
  /** A staged import let go. */
  unstage: { payload: { key: number }; result: null }
  /** The kernel let go and started afresh: the part is built again. */
  reset: { payload: Record<string, never>; result: null }
}

export type CadOp = keyof CadOps
export type CadPayload<K extends CadOp> = CadOps[K]['payload']
export type CadResult<K extends CadOp> = CadOps[K]['result']

export interface CadRequest {
  requestId: number
  op: CadOp
  payload: unknown
}

export interface CadResponse {
  requestId: number
  type: 'ok' | 'error'
  result?: unknown
  message?: string
}

/** What the kernel is at between answers — for the status strip. */
export type CadEvent = { kind: 'busy'; text: string }
