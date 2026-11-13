// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace's part in the app, for one render: the session (its
// kernel worker, its scene, the builds), the panel, and the export
// buttons' path out — see src/plugins/api.ts. The workspace asks for no
// scan: the part is built from its own first feature, and a scan loaded
// beside it is drawn as it is.

import { useEffect, useState } from 'react'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { useShell } from '../../../src/state/shellStore'
import { CadPanel } from '../ui/CadPanel'
import { createCadSession, installCadSession } from './cadSession'
import { exportCadFile } from './cadExport'

export function useCadPlugin(_host: PluginHost): PluginRuntime {
  // The session is the workspace: the kernel worker, the scene, and the
  // one who builds. Its transport is the page's worker; a headless run
  // hands a local one (plugin.ts) and the same code runs under Node.
  const [session] = useState(() => createCadSession())
  useEffect(() => installCadSession(session), [session])
  // The tab's own switch re-renders this hook, so the scene is made when
  // the workspace first comes on screen.
  useShell((s) => s.workspace)
  return {
    // No front door: the workspace shows its part with no scan loaded —
    // the part is built from its first feature.
    startPane: null,
    panel: <CadPanel onExport={(format) => void exportCadFile(format)} />,
  }
}
