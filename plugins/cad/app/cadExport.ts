// SPDX-License-Identifier: AGPL-3.0-only
// The part out of the workspace: STEP and STL through the kernel, named
// for the part, landed where it stands. The panel's buttons and the
// commands both come through here — one code path, as everywhere.

import { saveBuilt, exportStem, type BuiltFile } from '../../../src/app/exports'
import { cadSession } from './cadSession'
import { useCad } from '../state/cadStore'

/** The part (all bodies, or those named) as a file: the kernel writes it.
 *  Null with no session, or none built; `ids` to take a piece of the part. */
export async function buildCadFile(format: 'step' | 'stl', ids?: number[], units: 'mm' = 'mm'): Promise<BuiltFile | null> {
  void units
  const s = cadSession()
  if (!s) return null
  const st = useCad.getState()
  if (st.bodies.size === 0 && st.features.length > 0) await s.build()
  const now = useCad.getState()
  if (now.bodies.size === 0) return null
  const picked = ids && ids.length > 0 ? [...now.bodies.values()].filter((b) => ids.includes(b.id)) : [...now.bodies.values()]
  if (picked.length === 0) return null
  const out = await s.client.export(format, { ids, name: exportStem() || now.name })
  const volume = picked.reduce((sum, b) => sum + b.volume, 0)
  return {
    name: out.name,
    mimeType: out.mime,
    bytes: out.bytes,
    status:
      `${out.name} — ${picked.length} ${picked.length === 1 ? 'body' : 'bodies'}, ` +
      `${(volume / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} cm³.`,
  }
}

/** Hand the part over, as the panel's button does. */
export async function exportCadFile(format: 'step' | 'stl'): Promise<void> {
  saveBuilt(await buildCadFile(format))
}
