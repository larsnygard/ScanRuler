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
- [x] **M1 — Kernel adapter** `core/kernel.ts` (+`kernelTypes.ts`,
  `wasmSupport.ts`): occt-wasm wrapped to ~25 operations the module speaks
  (prisms, revolve, loft, booleans, fillet/chamfer, shell, patterns,
  transforms, mesh, STEP/STL in-out, volume/area/bbox, closedness),
  dynamic import, handle release discipline. Unit tests in Node (fa034e3).
- [x] **M2 — Pure geometry** `core/`: transforms/planes
  (`frame.ts`), 2D sketch entities + loop closure + tessellation
  (`sketch2d.ts`), 2D constraint solver (`solver2d.ts`: coincident,
  horizontal/vertical, parallel, perpendicular, distance, radius, tangent,
  equal, fixed — Newton-Raphson over point DOFs), profile/loop sorting
  (`loops2d.ts`). Pure, Node-testable (fa034e3).
- [x] **M3 — Part builder + build engine** `core/part.ts`,
  `core/build.ts`, `state/cadStore.ts`: typed feature list
  (primitive/sketch/extrude/revolve/loft/boolean/fillet/chamfer/
  linearPattern/circularPattern/mirror/shell/component), compiled in order
  to kernel shapes with per-feature result (built | failed + reason), body
  bookkeeping (visible, per-body result feature). (3890e06, 17 kernel-
  backed build tests, 57 CAD tests total.)
- [x] **M4 — Agent commands** `app/cadCommands.ts`, registered under
  `cad.*`: `status`, `reset`, `box`, `cylinder`, `sphere`, `sketch`,
  `extrude`, `revolve`, `loft`, `boolean`, `fillet`, `chamfer`, `shell`,
  `pattern`, `set` (any feature's numbers — the one way to edit),
  `remove` (a feature and everything made of it), `export` (STEP/STL as
  base64), `import` (a STEP/STL body staged and laid on the list as a
  component). Each change is one undo step (`Agent: …`), awaits its build,
  answers every feature's outcome, and leaves the list as it was when it
  is refused. Guide `guides/cad.md` registered. State section under
  `plugins.cad`. All commands headless (the kernel in-thread). 10 command
  tests through `tests/commandKit.ts` over the real kernel.
- [x] **M5 — Workspace UI** `ui/CadPanel.tsx` + CSS: feature tree,
  primitives row, sketch editor (pick plane → draw entities → constrain →
  finish), feature dialogs (depth, angle, fillet radius…), bodies list.
  View-bar part keys (bodies, wireframe, sketches).
- [x] **M6 — Scene layer** `viewer/cadScene.ts` + `app/useCadPlugin.tsx`:
  bodies as shaded meshes + wireframes, sketches on their planes, pick of
  bodies/faces/edges (topology tokens `F:<body>:<hash>`), selection
  highlight, plane faces for sketch placement.
- [x] **M7 — Integration**: `plugin.ts` registers it all: undo history
  section (the feature list is the step), project section (`cad` key —
  features as JSON + imported bodies as members, restored by staging them
  on the kernel and rebuilding), busy registration, view toggles
  (`view.set { bodies, sketches }`), icon `wsCad`, notices (OCCT /
  occt-wasm), guides. The kernel worker is `kernelWorker.ts`, not
  `worker.ts` — that name belongs to the mesh worker's plugin glob.
- [~] **M8 — MCP**: regenerate `mcp/src/commands.json` snapshot with the
  `cad.*` commands so the scanruler-mcp server serves the full CAD suite
  to agents; verify with the local engine (`--engine`) end to end.
- [x] **M9 — Tests**: kernel, geometry, build (57) and command-surface
  (10) tests under `plugins/cad/tests/`, through `tests/commandKit.ts`
  over the real kernel; the headless engine lists all 18 `cad.*` commands
  and runs them (checked against `src/headless/engine.ts` directly).
  `npm test`: 3201 tests, all passing (3 known-flaky under load, green in
  isolation). `npm run build` (tsc + vite): clean. Boundary check: holds.
  One real fix found: the plugin's kernel worker must not be
  `plugins/cad/worker.ts` — the mesh worker's plugin glob
  (`plugins/*/worker.ts`) picked it up as a worker plugin (`undefined`
  default export) and broke ~100 core command tests. Renamed
  `kernelWorker.ts`.
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
