# CAD module — project plan

Goal: turn ScanRuler (scan measurement + reverse engineering) into a full
CAD suite by adding a general-purpose **CAD workspace** as a plugin:
parametric solid modelling from scratch (no scan needed) — primitives,
sketches with constraints, extrude/revolve/loft, booleans, fillet/chamfer,
patterns, shell, assembly placements, STEP/STL/3MF export — with the full
agent command surface so the scanruler-mcp server drives it, verified by
unit tests + a browser check, deployed to https://snart.com/scanruler.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (with the commit
that closed it).

Architecture (decided 2026-11-13, after reading the tree):

- The app finds plugins by a glob of `plugins/*/plugin.ts` — the CAD module
  is a self-contained plugin `plugins/cad/`, id `cad`, workspace id `cad`,
  commands `cad.*`. It must **not** import from `plugins/reverse/` (the
  boundary script forbids it); it shares only the npm `occt-wasm` kernel.
- Feature-list model (like Reverse engineer): a list of parametric
  `Feature`s compiled in order to OCCT shapes by a `CadClient`; the kernel
  is a 5 MB WASM package loaded on demand, its handle bookkeeping owned by
  the client; a build is one step of the undo history.
- Runs headless (Node) for the MCP engine and the unit tests, exactly like
  `plugins/reverse` does (`headless()` + in-process kernel in tests).

## Milestones

- [x] **M0 — Plan + branch.** This file; branch `cad-module` from main (78d33d4).
- [~] **M1 — Kernel adapter** `core/kernel.ts` (+`kernelTypes.ts`,
  `wasmSupport.ts`): occt-wasm wrapped to ~25 operations the module speaks
  (prisms, revolve, loft, booleans, fillet/chamfer, shell, patterns,
  transforms, mesh, STEP/STL in-out, volume/area/bbox, closedness),
  dynamic import, handle release discipline. Unit tests in Node.
- [ ] **M2 — Pure geometry** `core/`: transforms/planes
  (`frame.ts`), 2D sketch entities + loop closure + tessellation
  (`sketch2d.ts`), 2D constraint solver (`solver2d.ts`: coincident,
  horizontal/vertical, parallel, perpendicular, distance, radius, tangent,
  equal, fixed — Newton-Raphson over point DOFs), profile/loop sorting
  (`loops2d.ts`). Pure, Node-testable.
- [ ] **M3 — Part builder + build engine** `core/partBuilder.ts`,
  `core/build.ts`, `state/cadStore.ts`: typed feature list
  (primitive/sketch/extrude/revolve/loft/boolean/fillet/chamfer/
  linearPattern/circularPattern/mirror/shell/component), compiled in order
  to kernel shapes with per-feature result (built | failed + reason), body
  bookkeeping (visible, per-body result feature).
- [ ] **M4 — Agent commands** `app/cadCommands.ts`: `cad.state`,
  `cad.build`, `cad.list`, `cad.primitive.add`, `cad.sketch.open/add/set/
  close`, `cad.extrude`, `cad.revolve`, `cad.loft`, `cad.boolean`,
  `cad.fillet`, `cad.chamfer`, `cad.pattern`, `cad.mirror`, `cad.shell`,
  `cad.feature.set/delete`, `cad.body.set`, `cad.component.add/set`,
  `cad.measure`, `cad.export` (STEP/STL/3MF), `cad.select`, `cad.undo/redo`.
  Register guide (`guides/cad.md`). State section under `plugins.cad`.
  Headless-capable. Command tests through `tests/commandKit.ts`.
- [ ] **M5 — Workspace UI** `ui/CadPanel.tsx` + CSS: feature tree,
  primitives row, sketch editor (pick plane → draw entities → constrain →
  finish), feature dialogs (depth, angle, fillet radius…), bodies list.
  View-bar part keys (bodies, wireframe, sketches).
- [ ] **M6 — Scene layer** `viewer/cadScene.ts` + `app/useCadPlugin.tsx`:
  bodies as shaded meshes + wireframes, sketches on their planes, pick of
  bodies/faces/edges (topology tokens `F:<body>:<hash>`), selection
  highlight, plane faces for sketch placement.
- [ ] **M7 — Integration**: undo history section, project section
  (`cadSection` — features as JSON), keyboard, busy registration,
  view toggles (`view.set { bodies, sketches, wireframe }`),
  `section.render` layers, icon `wsCad`, notices (OCCT), CHANGELOG entry,
  plugin README.
- [ ] **M8 — MCP**: regenerate `mcp/src/commands.json` snapshot with the
  `cad.*` commands so the scanruler-mcp server serves the full CAD suite
  to agents; verify with the local engine (`--engine`) end to end.
- [ ] **M9 — Tests**: unit (kernel, sketch, solver, build, commands,
  project round-trip), golden build checks (a 6-seed part zoo: volume,
  faces, edges), boundary check, `npm test`, `npm run build` (tsc).
- [ ] **M10 — Browser check** `plugins/cad/scripts/e2e-cad.mjs` +
  `ci.json`: open app, switch to CAD, box → fillet → export via UI/agent,
  screenshot; run in `e2e:ci`.
- [ ] **M11 — Deploy + push**: `./sendscanruler.sh` to snart.com/scanruler,
  verify live page loads the CAD tab (browser against the live URL),
  push branch + merge to main on larsnygard/ScanRuler.
- [ ] **M12 — Report**: progress recorded in this file per milestone;
  summary with what was verified.

## Standing rules

- Every file: `// SPDX-License-Identifier: AGPL-3.0-only` header.
- `node scripts/check-plugin-boundary.mjs` must pass after every commit.
- Commands are the panel's own code path; one undo step each.
- Do not touch `src/` app code beyond what integration requires (icon,
  nothing importing plugins/).
