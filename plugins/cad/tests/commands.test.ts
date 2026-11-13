// SPDX-License-Identifier: AGPL-3.0-only
// The agent's way in, run for real: the CAD commands through the app's
// command registry, over the kernel in this thread, with the session
// installed and no viewport. Each test runs commands and reads the part
// back — features, bodies, volumes — as an agent does.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { run, refused, startHeadless, type Headless } from '../../../tests/commandKit'
import { clearHistory, useHistory } from '../../../src/state/historyStore'
import { createCadSession, installCadSession, type CadSession } from '../app/cadSession'
import { localCad } from '../core/cadLocal'
import { useCad } from '../state/cadStore'
import plugin from '../plugin'

vi.setConfig({ testTimeout: 180_000 })

interface BodyOut { id: number; name: string; volume: number; closed: boolean }
interface StatusOut { name: string; status: string; features: { index: number; kind: string; ok: boolean | null }[]; bodies: BodyOut[]; message?: string }
interface ChangeOut { built: number; blocked: number; added?: number; message?: string }

let headless: Headless
let session: CadSession

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createCadSession(localCad())
  installCadSession(session)
  // One build warms the kernel so the tests below measure the work, not
  // the ~10 MB load.
  await run('cad.box', { width: 1, depth: 1, height: 1 })
  await empty()
}, 180_000)

afterAll(() => {
  session.dispose()
  headless.stop()
})

/** A build in play settles on its own; the commands refuse to run over
 *  one, so the tests wait it out (the agent's own pattern, per cadBusy). */
async function idle() {
  for (let i = 0; i < 3_000 && useCad.getState().status === 'building'; i++) await new Promise((r) => setTimeout(r, 25))
}

async function empty() {
  useCad.getState().setFeatures([])
  await idle()
}

beforeEach(async () => {
  await empty()
  clearHistory()
  useHistory.setState({ past: [], future: [] })
})
afterEach(empty)

const status = () => run<StatusOut>('cad.status')

describe('the verbs', () => {
  it('grows a box and reads it back', async () => {
    const out = await run<ChangeOut>('cad.box', { width: 40, depth: 30, height: 20, name: 'Plate' })
    expect(out.added).toBe(1)
    expect(out.built).toBe(1)
    const st = await status()
    expect(st.features).toHaveLength(1)
    expect(st.features[0].kind).toBe('box')
    expect(st.bodies).toHaveLength(1)
    expect(st.bodies[0].volume).toBeCloseTo(24000, 0)
    expect(st.bodies[0].closed).toBe(true)
  })

  it('fuses two boxes into one body', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    await run('cad.box', { width: 10, depth: 10, height: 40 })
    const out = await run<ChangeOut>('cad.boolean', { op: 'fuse', a: 0, b: 1 })
    expect(out.built).toBe(3)
    const st = await status()
    // The list keeps its three: the two boxes and the fuse made of them.
    expect(st.bodies).toHaveLength(3)
    // 24000 + 4000, the 10×10×20 overlap counted once.
    expect(st.bodies[2].volume).toBeCloseTo(26000, 0)
  })

  it('refuses a boolean over a sketch', async () => {
    await run('cad.box', {})
    await run('cad.sketch', { entities: [{ center: [0, 0], radius: 5 }] })
    const e = await refused('cad.boolean', { op: 'fuse', a: 0, b: 1 })
    expect(e.code).toBe('invalid_input')
  })

  it('refuses a feature index off the list', async () => {
    const e = await refused('cad.set', { feature: 4, patch: { width: 10 } })
    expect(e.code).toBe('invalid_input')
  })

  it('sets a number and rebuilds', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    await run('cad.set', { feature: 0, width: 10 })
    const st = await status()
    expect(st.bodies[0].volume).toBeCloseTo(6000, 0)
  })

  it('takes a feature and everything made of it', async () => {
    await run('cad.box', {})
    await run('cad.box', {})
    await run('cad.boolean', { op: 'fuse', a: 0, b: 1 })
    const out = await run<ChangeOut>('cad.remove', { feature: 0 })
    // Feature 0 and the fuse made of it (index 2) go; feature 1 stays.
    expect(out.added ?? 0).toBe(0)
    const st = await status()
    expect(st.features.map((f) => f.kind)).toEqual(['box'])
  })

  it('rounds every edge of a box', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    const out = await run<ChangeOut>('cad.fillet', { body: 0, radius: 3, edges: { which: 'all' } })
    expect(out.built).toBe(2)
    const st = await status()
    // Rounded corners take volume off the square corners.
    expect(st.bodies[1].volume).toBeLessThan(24000)
    expect(st.bodies[1].closed).toBe(true)
  })

  it('a failing feature stops the list and says so', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    // A fillet with a radius wider than the plate cannot round.
    await run('cad.fillet', { body: 0, radius: 25, edges: { which: 'all' } })
    const st = await status()
    expect(st.features[1].ok).toBe(false)
    expect(st.message).toBeTruthy()
  })

  it('writes the part as a file', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    const out = await run<{ file: { name: string; mimeType: string; bytes: string } }>('cad.export', { format: 'step' })
    expect(out.file.name.endsWith('.step')).toBe(true)
    const step = atob(out.file.bytes)
    expect(step).toContain('ISO-10303-21')
  })

  it('undoes a change back to nothing', async () => {
    await run('cad.box', { width: 40, depth: 30, height: 20 })
    const brief = await run<{ undone: string }>('history.undo')
    expect(brief.undone).toBe('Agent: add a box')
    expect((await status()).features).toHaveLength(0)
  })
})
