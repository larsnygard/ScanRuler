// SPDX-License-Identifier: AGPL-3.0-only
// The CAD kernel worker: a module worker that loads OCCT once and answers
// the requests core/protocol.ts names, through the service beside the
// kernel (core/service.ts). The page never touches the kernel; a build
// sends back meshes, not shapes.

import { CadService } from './core/service'
import type { CadEvent, CadRequest } from './core/protocol'

const service = new CadService((e: CadEvent) => {
  // What a build is at, told as it goes, unheard by any one promise.
  self.postMessage(e)
})

self.onmessage = async (e: MessageEvent) => {
  const req = e.data as CadRequest
  if (typeof req?.requestId !== 'number' || typeof req.op !== 'string') return
  const { response, transfer } = await service.handle(req)
  self.postMessage(response, { transfer })
}
