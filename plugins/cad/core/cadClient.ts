// SPDX-License-Identifier: AGPL-3.0-only
// The CAD worker behind a plain call. CadClient keeps a request's promise,
// routes progress, gives up on its timeout, and hands the page the part
// whole. How the request travels is the transport: WorkerRpc to the module
// worker on the page, cadLocal.ts in this thread under Node.

import { CAD } from './protocol'
import type { CadEvent, CadOp, CadPayload, CadRequest, CadResponse, CadResult } from './protocol'
import type { Feature } from './part'

/** One way a request travels. */
export interface CadTransport {
  onFailure: ((message: string) => void) | null
  onEvent?: ((e: CadEvent) => void) | null
  /** Send one, await its answer; transfer hands buffers over by move. */
  request<T>(msg: CadRequest, transfer?: Transferable[], timeoutMs?: number): Promise<T>
  dispose(): void
}

function isCadEvent(e: unknown): e is CadEvent {
  return typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'busy' && typeof (e as { text?: unknown }).text === 'string'
}

/** How long a request may take before its promise gives up: a build walks
 *  the whole feature list on a 5 MB kernel; a read is past that. */
const BUILD_MS = 600_000
const READ_MS = 120_000

/** Post each request to a module worker, await its answer, and route what
 *  it sends on its own. One worker for all requests, made on the first. */
class WorkerRpc {
  private worker: Worker | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  onFailure: ((message: string) => void) | null = null
  onEvent: ((e: CadEvent) => void) | null = null

  private ensure(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL('../kernelWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent) => this.received(e.data)
      worker.onerror = (e) => {
        // A worker that dies takes all waiting with it.
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error(e.message ? `The CAD worker failed: ${e.message}` : 'The CAD worker died at the kernel.'))
        }
        this.pending.clear()
        this.onFailure?.('The CAD worker died at the kernel. Reload the page.')
      }
      this.worker = worker
    }
    return this.worker
  }

  private received(data: unknown): void {
    if (isCadEvent(data)) {
      this.onEvent?.(data)
      return
    }
    const msg = data as CadResponse
    const entry = this.pending.get(msg.requestId)
    if (!entry) return
    this.pending.delete(msg.requestId)
    clearTimeout(entry.timer)
    if (msg.type === 'error') entry.reject(new Error(msg.message ?? 'The CAD kernel failed.'))
    else entry.resolve(msg.result)
  }

  async request<T>(msg: CadRequest, transfer: Transferable[] = [], timeoutMs = READ_MS): Promise<T> {
    const worker = this.ensure()
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId)
        reject(new Error('The CAD kernel did not answer in time.'))
      }, timeoutMs)
      this.pending.set(msg.requestId, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
    worker.postMessage(msg, transfer)
    return promise
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('The CAD worker was shut down.'))
    }
    this.pending.clear()
  }
}

/** A build's outcome, as the page gets it. */
export type BuildOutcome = CadResult<'build'>
export type ExportOutcome = { bytes: Uint8Array; name: string; mime: string }

let nextRequestId = 1

/** The CAD kernel, behind plain calls. */
export class CadClient {
  private rpc: CadTransport
  onFailure: ((message: string) => void) | null = null
  /** What a build is at (its feature, named), last told. */
  step: string | null = null

  constructor(transport?: CadTransport) {
    const rpc = transport ?? new WorkerRpc()
    if (!transport && rpc instanceof WorkerRpc) rpc.onEvent = (e) => this.heard(e)
    if (transport) transport.onEvent = (e) => this.heard(e)
    rpc.onFailure = (message) => this.onFailure?.(message)
    this.rpc = rpc
  }

  private heard(e: CadEvent): void {
    this.step = e.kind === 'busy' ? e.text : null
    this.onStep?.(this.step)
  }
  /** The build's step callback, while one is in play. */
  private onStep: ((text: string | null) => void) | null = null

  private async call<K extends CadOp>(op: K, payload: CadPayload<K>, transfer: Transferable[] = [], timeoutMs = READ_MS): Promise<CadResult<K>> {
    const msg: CadRequest = { requestId: nextRequestId++, op, payload: structuredCloneable(payload) as unknown }
    return this.rpc.request<CadResult<K>>(msg, transfer, timeoutMs)
  }

  /** Compile the feature list: one result per feature, the bodies as
   *  meshes to draw, the sketches as settled outlines. onStep hears what
   *  it is at; signal ends the caller's waiting (the kernel finishes the
   *  build — its answer simply goes unheard). */
  async build(features: Feature[], opts: { deflection?: number; signal?: AbortSignal; onStep?: (text: string | null) => void } = {}): Promise<BuildOutcome> {
    if (opts.signal?.aborted) return Promise.reject(new DOMException('The build was stopped.', 'AbortError'))
    this.onStep = opts.onStep ?? null
    try {
      return await this.call('build', { features, deflection: opts.deflection }, [], BUILD_MS)
    } finally {
      this.onStep = null
    }
  }

  /** The part (all bodies, or those named) as a file. */
  async export(format: 'step' | 'stl' | '3mf', opts: { ids?: number[]; deflection?: number; name?: string } = {}): Promise<ExportOutcome> {
    const out = await this.call('export', { format, ids: opts.ids, deflection: opts.deflection, name: opts.name }, [], BUILD_MS)
    return { ...out, bytes: new Uint8Array(out.bytes as unknown as ArrayBuffer) }
  }

  /** Bytes in: a STEP or STL body, staged beside the part; its key names
   *  it to an imported feature. */
  async stage(bytes: Uint8Array, format: 'step' | 'stl'): Promise<{ key: number; closed: boolean }> {
    const copy = bytes.slice()
    return this.call('stage', { bytes: copy, format }, [copy.buffer])
  }

  unstage(key: number): Promise<null> {
    return this.call('unstage', { key })
  }

  /** Let the kernel go and start afresh: the part is built again. */
  reset(): Promise<null> {
    return this.call('reset', {})
  }

  dispose(): void {
    this.rpc.dispose()
  }
}

/** structuredClone hands the feature list over as-is; TypedArrays inside
 *  (a sketch's start values) ride along. Nothing to do — kept as a named
 *  step so a payload that needs a transfer says so here. */
function structuredCloneable(payload: object): object {
  return payload
}

export { CAD }
