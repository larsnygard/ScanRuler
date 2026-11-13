// SPDX-License-Identifier: AGPL-3.0-only
// One CAD workspace's working session: the kernel worker (core/cadClient.ts)
// the part is built on, the part drawn in the viewport (view/cadScene.ts),
// and the store that says what it all is (state/cadStore.ts).
//
// The session is the only one who builds: a change to the feature list
// asks for a build, one at a time — a build asked for while one is in play
// waits, and a change that arrives past a whole queue builds from the list
// as it stands then. What stands after a build: drawn, offered as solids
// to the rest of the app, and read by the commands.
//
// The worker is the page's; a headless run hands a local transport
// (core/cadLocal.ts) and the same code runs under Node.

import { offerSolids, type OfferedSolid } from '../../../src/app/solids'
import { sceneOf } from '../../../src/commands/host'
import { CadClient, type CadTransport } from '../core/cadClient'
import { CadScene } from '../view/cadScene'
import { useCad } from '../state/cadStore'
import type { BuildResult } from '../core/part'
import type { BuiltShape } from '../core/types'

/** Who a CAD part's bodies come from, as Mesh Tools lists them. */
const SOLID_SOURCE = 'CAD part'

export interface CadSession {
  client: CadClient
  /** The scene, when the viewport is here. */
  scene: CadScene | null
  /** Ask for the part to be built from the list as it stands. Settled
   *  when the build lands (or is overtaken by a newer one). */
  build(): Promise<void>
  /** The part titled, for a file's name. */
  setName(name: string): void
  /** Bytes in: a body staged beside the part; its key names it to an
   *  imported feature. */
  stage(bytes: Uint8Array, format: 'step' | 'stl'): Promise<{ key: number; closed: boolean }>
  unstage(key: number): Promise<void>
  /** What is staged, as it came in — what a project saves beside the list,
   *  and lays on the kernel again when the file is opened. */
  staged(): { key: number; format: 'step' | 'stl'; bytes: Uint8Array }[]
  /** Let the kernel go: the part is built again on the next change. */
  reset(): Promise<void>
  dispose(): void
}

let current: CadSession | null = null

export function cadSession(): CadSession | null {
  return current
}

/** The session's verbs, bound for the commands: the worker behind them. */
export function cadOf(session: CadSession): CadClient {
  return session.client
}

export function createCadSession(transport?: CadTransport): CadSession {
  const client = new CadClient(transport)
  client.onFailure = (message) => {
    const s = useCad.getState()
    s.setStatus('failed')
    s.setKernelGone(true)
    s.setResults([], [], [], false, message)
  }

  /** The kernel's bodies, offered to every workspace that works on meshes:
   *  Mesh Tools' Boolean takes them out of a scan; nothing else knows they
   *  came from here. */
  let solidVersion = 0
  const offerBodies = (bodies: BuiltShape[]) => {
    const solids: OfferedSolid[] = bodies.map((b) => ({
      key: `cad:${b.id}`,
      name: b.name,
      source: SOLID_SOURCE,
      version: solidVersion,
      async mesh(chord: number) {
        // The mesh the build already made, at the finest chord asked for
        // — the kernel's deflection is finer than any mesh tool asks.
        void chord
        return { positions: b.mesh.positions.slice(), indices: b.mesh.indices.slice() }
      },
    }))
    offerSolids('cad', solids)
  }

  /** What is staged beside the part, as it came in: bytes the project
   *  saves and lays on the kernel again when the file is opened. */
  const staged = new Map<number, { format: 'step' | 'stl'; bytes: Uint8Array }>()

  /** The scene, once: the viewport outlives a kernel, not a workspace. */
  let scene: CadScene | null = null
  const ensureScene = (): CadScene | null => {
    if (scene) return scene
    const s = sceneOf()
    if (!s) return null
    scene = new CadScene(s)
    scene.onBodyPick = (id, point) => {
      // A click on a body: the panel selects the feature that made it, and
      // a tool in hand that names a point (a fillet's edge) takes it.
      const st = useCad.getState()
      st.setSelected(id)
      st.pickPoint?.(id, point)
      void st
    }
    return scene
  }

  // One build in play; a request past it runs again when it lands.
  let running: Promise<void> | null = null
  let again = false

  async function run(): Promise<void> {
    const s = useCad.getState()
    s.setStatus('building', null)
    try {
      const out = await client.build(s.features, {
        onStep: (text) => useCad.getState().setStatus('building', text),
      })
      const st = useCad.getState()
      if (st.features !== s.features) {
        // The list changed while this was in play: build the list as it
        // stands now.
        again = true
        return
      }
      const failed = out.results.filter((r: BuildResult) => !r.ok)
      st.setResults(out.results, out.bodies, out.profiles, failed.length === 0, failed.length > 0 ? `${failed.length} of ${out.results.length} features did not build.` : null)
      const sc = ensureScene()
      if (sc) {
        sc.setBodies(out.bodies, useCad.getState().selected)
        sc.setSketches(out.profiles)
        // A new build paints fresh meshes: the view's switches ride on.
        const st2 = useCad.getState()
        sc.setBodiesHidden(st2.bodiesHidden)
        sc.setSketchesHidden(st2.sketchesHidden)
      }
      solidVersion++
      offerBodies(out.bodies)
    } catch (e) {
      const st = useCad.getState()
      st.setStatus('failed')
      st.setResults(st.results, [...st.bodies.values()], [...st.profiles.values()], false, e instanceof Error ? e.message : String(e))
    }
  }

  const session: CadSession = {
    client,
    get scene() {
      return scene
    },
    async build() {
      if (running) {
        again = true
        return running
      }
      running = run().then(async () => {
        const first = running
        running = null
        if (again) {
          again = false
          await session.build()
        }
        void first
      })
      return running
    },
    setName(name: string) {
      useCad.getState().setName(name)
    },
    async stage(bytes, format) {
      const out = await client.stage(bytes, format)
      staged.set(out.key, { format, bytes: bytes.slice() })
      return out
    },
    async unstage(key) {
      staged.delete(key)
      await client.unstage(key)
    },
    staged() {
      return [...staged.entries()].map(([key, v]) => ({ key, format: v.format, bytes: v.bytes.slice() }))
    },
    async reset() {
      await client.reset()
      useCad.getState().setKernelGone(false)
      offerBodies([])
    },
    dispose() {
      scene?.dispose()
      scene = null
      offerBodies([])
      client.dispose()
      if (current === session) current = null
    },
  }

  // Every change to the feature list asks for a build — the panel's
  // fields, a command, a project loaded: all of them go through the list.
  useCad.subscribe((s, prev) => {
    if (s.features !== prev.features) void session.build()
    if (s.selected !== prev.selected) scene?.setSelected(s.selected)
    if (s.bodiesHidden !== prev.bodiesHidden) scene?.setBodiesHidden(s.bodiesHidden)
    if (s.sketchesHidden !== prev.sketchesHidden) scene?.setSketchesHidden(s.sketchesHidden)
  })

  return session
}

export function installCadSession(session: CadSession): void {
  current = session
}

