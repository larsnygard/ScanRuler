// SPDX-License-Identifier: AGPL-3.0-only
// What each CAD request does, beside the kernel: the service the worker
// runs it in (kernelWorker.ts), and that cadLocal.ts runs in this thread under
// Node — the tests and the headless run driving the workspace exactly as
// the page does.
//
// The service owns the kernel and the last build's shapes. A build
// releases the shapes of the build before it — the part's shapes live
// here, not on the page — and describes what it made into meshes to draw.
// The export asks for shapes by feature id, the staged imports sit beside
// them, and a reset lets the kernel go and starts a new one.

import { CadKernel } from './kernel'
import { PartBuilder } from './build'
import { profileOutlines } from './build'
import type { CadEvent, CadPayload, CadRequest, CadResponse, CadResult } from './protocol'
import { featureDeps } from './part'
import type { Feature } from './part'
import type { BuiltShape } from './types'

/** How finely a body is meshed for the page, mm chord: the bore's wall
 *  within a hundredth of its round, as the Reverse engineer meshes to. */
export const DEFAULT_DEFLECTION = 0.05

/** A file named for the part: what the panel saves, what a command hands
 *  back. */
function fileName(basis: string, ext: string): string {
  const stem = basis.trim().replace(/[^\w.-]+/g, '_').replace(/_+$/, '') || 'part'
  return `${stem}.${ext}`
}

export class CadService {
  private kernel: CadKernel | null = null
  private loading: Promise<CadKernel> | null = null
  /** The last build's shapes, by feature id — the export's to read, the
   *  next build's to release. */
  private shapes = new Map<number, number>()
  /** A staged import, by its key: the imported feature's body. */
  private staged = new Map<number, number>()
  private nextKey = 1
  /** What a build is working on, for the status line. */
  private step: string | null = null

  constructor(private emit: (e: CadEvent) => void = () => {}) {}

  /** The kernel, fetched and compiled once — 5 MB, only when the first
   *  request comes. `wasm` lets a test hand the binary in. */
  private async ensure(wasm?: string | Uint8Array): Promise<CadKernel> {
    if (this.kernel) return this.kernel
    if (!this.loading) {
      this.emit({ kind: 'busy', text: 'Loading the CAD kernel…' })
      this.loading = CadKernel.load(wasm).then(
        (k) => {
          this.kernel = k
          this.loading = null
          this.step = null
          return k
        },
        (e) => {
          this.loading = null
          throw e
        },
      )
    }
    return this.loading
  }

  /** The feature list compiled: the results, the bodies meshed for the
   *  page, the sketches' settled outlines. The build's intermediates are
   *  released; the bodies kept for the export. */
  private async build(payload: CadPayload<'build'>): Promise<CadResult<'build'>> {
    const k = await this.ensure()
    // A new build: the part's shapes from the last one go.
    for (const s of this.shapes.values()) k.release(s)
    this.shapes.clear()

    const builder = new PartBuilder(k)
    const out = builder.build(payload.features, (text) => {
      this.step = text
      this.emit({ kind: 'busy', text })
    })
    this.step = null

    const deflection = payload.deflection ?? DEFAULT_DEFLECTION
    // What stands as a body to draw: every feature that made a shape,
    // last-wins by id — the meshes cross the wire, so this is the one
    // place they are made.
    const bodies: BuiltShape[] = []
    for (const f of payload.features) {
      const shape = out.shapes.get(f.id)
      if (shape === undefined) continue
      this.shapes.set(f.id, shape)
      bodies.push(k.describe(shape, deflection, f.id, f.name || f.kind))
    }
    const profiles = [...out.profiles.entries()].map(([id, p]) => ({
      id,
      plane: p.plane,
      outlines: profileOutlines(p),
      residual: p.residual,
    }))
    return { results: out.results, bodies, profiles }
  }

  /** The part as a file. No ids: every body standing. */
  private async export(payload: CadPayload<'export'>): Promise<CadResult<'export'>> {
    const k = await this.ensure()
    const ids = payload.ids && payload.ids.length > 0 ? payload.ids : [...this.shapes.keys()]
    const shapes = ids.map((id) => this.shapes.get(id)).filter((s): s is number => s !== undefined)
    // Staged imports count as part of the part when named by their key.
    for (const id of ids) {
      const s = this.staged.get(id)
      if (s !== undefined && !shapes.includes(s)) shapes.push(s)
    }
    if (shapes.length === 0) throw new Error('There is no body to export yet — build the part first.')
    if (payload.format === 'step') {
      const text = k.exportStep(shapes)
      const bytes = new TextEncoder().encode(text)
      return { bytes, name: fileName(payload.name ?? this.name, 'step'), mime: 'model/step' }
    }
    const bytes = k.exportStl(shapes, payload.deflection ?? DEFAULT_DEFLECTION)
    return { bytes, name: fileName(payload.name ?? this.name, 'stl'), mime: 'model/stl' }
  }

  /** The part's name, as the panel titled it — the file names follow. */
  name = 'part'


  private async stage(payload: CadPayload<'stage'>): Promise<CadResult<'stage'>> {
    const k = await this.ensure()
    const shape = payload.format === 'step' ? k.importStep(new TextDecoder().decode(payload.bytes)) : k.importStl(payload.bytes)
    const key = this.nextKey++
    this.staged.set(key, shape)
    const m = k.measures(shape)
    return { key, closed: m.closed }
  }

  private unstage(payload: CadPayload<'unstage'>): null {
    const s = this.staged.get(payload.key)
    if (s !== undefined && this.kernel) {
      this.kernel.release(s)
      this.staged.delete(payload.key)
    }
    return null
  }

  /** Let the kernel go and start afresh: the part's shapes go with it. */
  private async reset(): Promise<null> {
    const k = this.kernel
    this.kernel = null
    this.loading = null
    this.shapes.clear()
    this.staged.clear()
    this.step = null
    k?.dispose()
    return null
  }

  /** Answer one request. Never rejects: a fault comes back as an error
   *  response, the caller's message telling what it was working on. */
  async handle(req: CadRequest): Promise<{ response: CadResponse; transfer: Transferable[] }> {
    try {
      let result: unknown
      const transfer: Transferable[] = []
      switch (req.op) {
        case 'build':
          result = await this.build(req.payload as CadPayload<'build'>)
          break
        case 'export': {
          const out = await this.export(req.payload as CadPayload<'export'>)
          // The bytes cross without a copy.
          result = { ...out, bytes: out.bytes.buffer }
          transfer.push(out.bytes.buffer)
          break
        }
        case 'stage':
          result = await this.stage(req.payload as CadPayload<'stage'>)
          break
        case 'unstage':
          result = this.unstage(req.payload as CadPayload<'unstage'>)
          break
        case 'reset':
          result = await this.reset()
          break
        default:
          throw new Error(`Unknown CAD request: ${String(req.op)}`)
      }
      return { response: { requestId: req.requestId, type: 'ok', result }, transfer }
    } catch (e) {
      this.step = null
      return { response: { requestId: req.requestId, type: 'error', message: e instanceof Error ? e.message : String(e) }, transfer: [] }
    }
  }

  /** What a build is at, between answers — null between them. */
  current(): string | null {
    return this.step
  }

  /** Every feature list the build read from, for the tests. */
  static depsOf(features: Feature[]): Map<number, number[]> {
    return new Map(features.map((f) => [f.id, featureDeps(f)]))
  }
}
