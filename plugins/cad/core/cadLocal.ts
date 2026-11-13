// SPDX-License-Identifier: AGPL-3.0-only
// The kernel in this thread, for Node, which has no workers: a transport
// for CadClient that hands each request to the worker's own service
// (service.ts) and gives back its answer — the tests drive the workspace
// through it, and the app run headless (plugin.ts headless) builds through
// it, exactly as the page does. Nothing is transferred: both ends are in
// one thread.

import { CadService } from './service'
import type { CadTransport } from './cadClient'
import type { CadRequest } from './protocol'

export function localCad(): CadTransport {
  let disposed = false
  const transport: CadTransport = {
    onFailure: null,
    onEvent: null,
    async request<T>(msg: CadRequest): Promise<T> {
      if (disposed) throw new Error('The CAD kernel was shut down.')
      const { response } = await service.handle(msg)
      if (response.type === 'error') throw new Error(response.message)
      return response.result as T
    },
    dispose() {
      disposed = true
    },
  }
  // What the kernel is at, told as the worker tells it — none once let go.
  const service = new CadService((e) => {
    if (!disposed) transport.onEvent?.(e)
  })
  return transport
}
