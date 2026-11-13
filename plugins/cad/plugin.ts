// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace, as the app finds it: see src/plugins/api.ts for what
// each part of this is to the app.

import { registerBusy, registerCommands, registerStateSection, registerViewToggles, type ScanRulerPlugin } from '../../src/plugins/api'
import { registerProjectSection } from '../../src/app/projectSections'
import { pick, registerHistory } from '../../src/state/historyStore'
import { useShell } from '../../src/state/shellStore'
import { cadProjectSection } from './app/projectSection'
import { cadBusy, cadCommands, describeCad } from './app/cadCommands'
import { sketchCommands } from './app/sketchCommands'
import { useCadPlugin } from './app/useCadPlugin'
import { useCad } from './state/cadStore'
import { CadNotices } from './ui/CadNotices'
import { registerCadGuides } from './guides/guides'
import './ui/cad.css'

const plugin: ScanRulerPlugin = {
  id: 'cad',
  name: 'CAD',
  workspace: {
    id: 'cad',
    label: 'CAD',
    title: 'Model a solid part from scratch — primitives, sketches, extrudes, booleans, rounds and shells — and export it as STEP, STL or 3MF',
    icon: 'wsCad',
    order: 15,
  },
  notices: CadNotices,
  install() {
    registerProjectSection(cadProjectSection)
    // What an agent works through: the verbs under cad.*, the workspace's
    // part of the session's readout, and what its kernel is busy with —
    // loading, or building the bodies — so no command runs over it.
    registerCommands('cad', [...cadCommands, ...sketchCommands])
    registerStateSection('cad', describeCad)
    registerBusy('cad', cadBusy, [useCad])
    // The list of features is the part: a change to it — the panel's
    // fields, a command — is the undo step, and an undo puts the list
    // back and builds it again.
    registerHistory({
      sections: [
        {
          key: 'cad',
          capture: () => pick(useCad.getState(), ['features', 'name']),
          apply: (value) => useCad.setState(value as Partial<ReturnType<typeof useCad.getState>>),
        },
      ],
      actions: [{ store: useCad, label: 'CAD', names: ['setFeatures', 'setName'] }],
      blocked: () => useCad.getState().status === 'building',
    })
    // How to go about modelling a part, for an agent — guide.read serves it.
    registerCadGuides()
    // What a picture of the workspace shows or puts away: the bodies as a
    // whole and the sketches — kept in the part, not drawn.
    registerViewToggles('cad', [
      {
        key: 'bodies',
        description: 'the CAD bodies in the viewport (kept in the part; eyes of individual bodies ride on)',
        applies: () => useShell.getState().workspace === 'cad',
        shown: () => !useCad.getState().bodiesHidden,
        show: (on) => useCad.getState().setBodiesHidden(!on),
      },
      {
        key: 'sketches',
        description: 'the sketches drawn in the viewport',
        applies: () => useShell.getState().workspace === 'cad',
        shown: () => !useCad.getState().sketchesHidden,
        show: (on) => useCad.getState().setSketchesHidden(!on),
      },
    ])
  },
  usePlugin: useCadPlugin,
  // The app run without a browser (src/headless/engine.ts): the workspace's
  // session over the kernel in this thread, as the tests run it — every CAD
  // command models through it, no viewport.
  async headless() {
    // The kernel's service in this thread, loaded only here: the page builds
    // in its worker and never takes the builder onto its own thread.
    const [{ localCad }, { createCadSession, installCadSession }] = await Promise.all([import('./core/cadLocal'), import('./app/cadSession')])
    const session = createCadSession(localCad())
    const previous = cadSession()
    installCadSession(session)
    return () => {
      if (previous) installCadSession(previous)
      session.dispose()
    }
  },
}

import { cadSession } from './app/cadSession'

export default plugin
