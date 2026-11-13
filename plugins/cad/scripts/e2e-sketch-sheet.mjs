// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the CAD sketch sheet: opens the CAD workspace,
// adds a sketch (a square), opens it on the sheet, draws a circle with
// the circle tool, drags one corner point of the square and watches the
// constraints pull the neighbours, presses Infer, and commits with Done
// — reading the feature back from the store as the panel shows it.
// Checks the sheet's pieces, the point counts, and that a clean run
// leaves no console errors.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/cad/scripts/e2e-sketch-sheet.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, click, drag, finish, launchApp, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1500, height: 950, protocolTimeout: 240_000 })

const sheet = async () =>
  page.evaluate(() => {
    const w = window.__cad
    if (!w) return null
    const s = w.sketch.getState()
    return { openId: s.openId, entities: s.draft?.entities.length ?? 0, constraints: s.draft?.constraints.length ?? 0, tool: s.tool, points: s.selection?.points.length ?? 0 }
  })

await page.click('[data-test=workspace-cad]')
await page.waitForSelector('[data-test=cad-features], [data-test=cad-empty]', { timeout: 30_000 })

// A fresh sheet: add a sketch (the panel's square) and open it.
await page.waitForSelector('[data-test=cad-tool-sketch]', { timeout: 30_000 })
await click(page, '[data-test=cad-tool-sketch]')
await sleep(400)
await click(page, '[data-test=cad-sketch-edit]')
await page.waitForSelector('[data-test=cad-sketch-stage]', { timeout: 15_000 })
check((await sheet())?.entities === 4, 'the sheet opens with the square’s four lines')

// The circle tool: centre, then rim. Two clicks on the sheet's svg.
const box = await page.evaluate(() => {
  const r = document.querySelector('.cad-sketch-sheet').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
await click(page, '.cad-sketch-tools .icobtn[aria-label="Circle"]')
await page.mouse.click(box.x + box.w * 0.72, box.y + box.h * 0.3)
await sleep(120)
await page.mouse.click(box.x + box.w * 0.72 + 30, box.y + box.h * 0.3)
await sleep(150)
check((await sheet())?.entities === 5, 'the circle tool put a fifth piece on the sheet')

// Select and drag a corner: pick-select tool, click the square's top-right
// vertex (the view fits the sketch: the square spans a known span of the
// sheet), then drag it and watch the welds and axes solve the rest.
await click(page, '.cad-sketch-tools .icobtn[aria-label="Select"]')
const view = await page.evaluate(() => {
  // Read the view's mapping off the drawn handles: the rightmost,
  // topmost point handle on the sheet.
  const rs = [...document.querySelectorAll('.cad-sketch-sheet rect.cad-sk-point')].map((r) => {
    const b = r.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  const top = rs.reduce((a, b) => (b.y < a.y ? b : a))
  return { rs, top }
})
await page.mouse.click(view.top.x, view.top.y)
await sleep(120)
check((await sheet())?.points >= 1, 'clicking a handle selects a point')
await drag(page, [view.top.x, view.top.y], [view.top.x + 40, view.top.y - 25])
const after = await sheet()
check(after?.entities === 5, 'the drag leaves the piece count alone (moves a point, adds nothing)')

// Infer reads the drawing back, then Done commits it to the feature list.
await click(page, '.cad-sketch-relations .btn[title^="Read the drawing back"]')
await sleep(150)
check((await sheet())?.constraints >= 8, 'Infer put constraints on the drawing')
await page.screenshot({ path: shotPath('sketch-sheet.png') })
await click(page, '[data-test=cad-sketch-done]')
await page.waitForSelector('[data-test=cad-sketch-stage]', { hidden: true, timeout: 15_000 })

// The sheet is gone; the feature list carries the edited sketch, and the
// build settled it. Read the part as the panel shows it.
const read = await page.evaluate(() => {
  const st = window.__cad.cad.getState()
  const f = st.features.find((x) => x.kind === 'sketch')
  return { entities: f?.entities.length ?? 0, constraints: f?.constraints.length ?? 0, built: st.results.find((r) => r.ok && st.features[r.index]?.kind === 'sketch')?.ok === true, status: st.status }
})
check(read?.entities === 5, 'Done wrote five pieces into the sketch (read back from the feature list)')
check((read?.constraints ?? 0) >= 8, 'the sketch carries the constraints Infer added')
check(read?.built === true, 'the sketch builds on the part')

await finish(browser, consoleErrors)
