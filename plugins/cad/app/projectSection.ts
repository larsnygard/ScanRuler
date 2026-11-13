// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace's part of a project file, under the key `cad`: the
// list of features that is the part, and the imported bodies as the
// kernel holds them — the bytes an agent staged, kept as files beside
// the models and laid on the kernel again when the project opens. The
// solids themselves are not saved: a part is its list, and the list is
// built again, the way a map is measured again.

import { cadSession } from './cadSession'
import { useCad } from '../state/cadStore'
import type { Feature } from '../core/part'
import type { ProjectSection } from '../../../src/app/projectSections'
import { array, fields, invalid, object } from '../../../src/core/project/validation'

const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'ellipsoid', 'sketch', 'extrude', 'revolve', 'loft', 'boolean', 'fillet', 'chamfer', 'shell', 'linearPattern', 'circularPattern', 'mirror', 'component'] as const

export interface CadPart {
  /** The list as the store holds it: each feature plain JSON, in order. */
  features: Record<string, unknown>[]
  /** Imported bodies' files, named by the key the kernel knows them by —
   *  `cad-import-<key>.step`. Absent: nothing was imported. */
  imports?: { key: number; member: string; format: 'step' | 'stl' }[]
}

/** Check a feature as read from a file: enough shape to build safely. The
 *  kernel is the judge of the numbers; this is the judge of the shape. */
function validateFeature(raw: unknown): void {
  const f = object(raw, 'cad.features[]')
  fields(f, 'id', 'number', 'cad.features[]')
  fields(f, 'name', 'string', 'cad.features[]')
  if (!Number.isSafeInteger(f.id) || (f.id as number) < 0) invalid('cad.features[].id')
  if (!KINDS.includes(f.kind as (typeof KINDS)[number])) invalid('cad.features[].kind')
  // A sketch carries its entities; the list must be one to hand to the
  // solver, so it must be an array.
  if (f.kind === 'sketch' && !Array.isArray(f.entities)) invalid('cad.features[].entities')
}

function validateCadPart(raw: unknown): CadPart {
  const x = object(raw, 'cad')
  if (!Array.isArray(x.features)) invalid('cad.features')
  for (const f of x.features) validateFeature(f)
  if (x.imports !== undefined) {
    const imports = array(x.imports, 'cad.imports')
    for (const i of imports) {
      const imp = object(i, 'cad.imports[]')
      fields(imp, 'key', 'number', 'cad.imports[]')
      fields(imp, 'member', 'string', 'cad.imports[]')
      if (imp.format !== 'step' && imp.format !== 'stl') invalid('cad.imports[].format')
    }
  }
  return {
    features: x.features as Record<string, unknown>[],
    imports: x.imports as CadPart['imports'],
  }
}

const memberName = (key: number, format: 'step' | 'stl') => `cad-import-${key}.${format}`

export const cadProjectSection: ProjectSection<CadPart> = {
  key: 'cad',

  collect(ctx) {
    const st = useCad.getState()
    const s = cadSession()
    if (st.features.length === 0 && !(s && s.staged().length > 0)) return undefined
    const imports: CadPart['imports'] = []
    if (s) {
      for (const staged of s.staged()) {
        const member = memberName(staged.key, staged.format)
        ctx.addMember(member, staged.bytes)
        imports.push({ key: staged.key, member, format: staged.format })
      }
    }
    return {
      // Plain JSON of the list, in order: what a build reads.
      features: JSON.parse(JSON.stringify(st.features)) as Record<string, unknown>[],
      imports: imports.length > 0 ? imports : undefined,
    }
  },

  members(value) {
    return (value.imports ?? []).map((i) => i.member)
  },

  prepare(value) {
    const part = validateCadPart(value)
    return () => {
      void part
    }
  },

  async restore(value, ctx) {
    const s = cadSession()
    if (!s) return
    // Lay the imported bodies on the kernel again, oldest first. The
    // kernel names them by a key of its own; the list's component bodies
    // spoke of the keys the file saved under, so follow the order the
    // file kept — the same order the keys come back in — and point the
    // list at what the kernel answers now.
    const imports = [...(value.imports ?? [])].sort((a, b) => a.key - b.key)
    const remap = new Map<number, number>()
    for (const imp of imports) {
      const bytes = ctx.members.get(imp.member)
      if (bytes) remap.set(imp.key, (await s.stage(bytes, imp.format)).key)
    }
    const features = JSON.parse(JSON.stringify(value.features)) as Feature[]
    for (const f of features) {
      if (f.kind === 'component' && remap.has(f.body)) f.body = remap.get(f.body)!
    }
    useCad.getState().setFeatures(features)
  },

  hasContent(value) {
    return value.features.length > 0 || (value.imports?.length ?? 0) > 0
  },

  holds(): Record<string, number> {
    const n = useCad.getState().features.length
    return n > 0 ? { features: n } : {}
  },

  watch(changed) {
    return useCad.subscribe((s, prev) => {
      if (s.features !== prev.features) changed()
    })
  },
}
