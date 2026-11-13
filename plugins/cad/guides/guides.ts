// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's guides, as guide.read serves them to an agent: how to
// go about modelling a part here — the list, the verbs, the kernel's
// habits. Loaded when first read, so the page carries none of it until an
// agent asks.

import { registerGuide } from '../../../src/plugins/api'

export function registerCadGuides(): void {
  registerGuide({
    id: 'cad',
    title: 'Modelling a part in the CAD workspace',
    when: 'designing or editing a solid part feature by feature — primitives, sketches, extrudes, revolves, lofts, booleans, fillets, chamfers, shells, patterns, imported bodies, STEP/STL export; how the feature list, the builds and the answers work, and the checks before a handover',
    text: () => import('./cad.md?raw').then((m) => m.default),
  })
}
