<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CAD

The CAD workspace, as a plugin — see [../README.md](../README.md) for what a
plugin is. What follows is the workspace's chapter of the app's documentation.

## CAD: modelling a solid part from nothing

The **CAD** workspace builds a parametric solid part with no scan: the part
grows from its first feature. The **list of features is the part** — as in
Reverse engineer — and every number on the list is editable; changing one
rebuilds everything downstream. The geometry is computed by the
[OCCT](https://dev.opencascade.org/) kernel compiled to WebAssembly
(`occt-wasm`), which runs in its own worker (`kernelWorker.ts`) and loads
(~10 MB) with the workspace's first build.

### The panel

- **Primitives**: box, cylinder, sphere — laid on the datum's origin.
- **Sketch**: pick a datum plane (xy/xz/yz, with offset and shift), draw
  rectangles, circles and polylines, and pull them with **Extrude** or
  **Revolve**; **Loft** stretches between sketches.
- **Boolean**: fuse, cut, intersect between two bodies.
- **Dress**: **Fillet** / **Chamfer** (every edge, or the one nearest a
  picked point), **Shell** (hollow at a wall thickness, opened through the
  top face, the bottom, or sealed), **Pattern** (linear, circular),
  **Mirror**.
- The **feature list** below shows the part; clicking a feature shows its
  numbers, which are edited in place. The bodies' eye puts a body away;
  the view bar's keys put the bodies and sketches away as a whole.
- **Export** writes the part as STEP (back to CAD) or STL (to a printer).

A click on a body selects the feature that made it, and hands the point to
a tool in hand that wants one (a fillet's edge to round).

### For an agent

The verbs run through `cad.*` — see `guide.read { id: 'cad' }`:

- `cad.status` reads the part: the list with each feature's outcome, the
  bodies with volume, area, bounds, closedness.
- `cad.box` / `cad.cylinder` / `cad.sphere` / `cad.sketch` /
  `cad.extrude` / `cad.revolve` / `cad.loft` / `cad.boolean` /
  `cad.fillet` / `cad.chamfer` / `cad.shell` / `cad.pattern` add a feature;
  each is one undo step, awaits its build, and answers every feature's
  outcome.
- `cad.set` changes a feature's numbers — the one way to edit. `cad.remove`
  takes a feature and everything made of it.
- `cad.import` stages a STEP/STL body and lays it on the list as a
  component (its staged key names it to a boolean); `cad.export` answers
  the part as a file's bytes.
- All of it runs headless (`scanruler-mcp --engine`): the same commands
  over the kernel in-thread, no viewport.

### Inside the project file

The project's `cad` key holds the feature list as plain JSON and the
imported bodies as files beside the models (`cad-import-<key>.step`); the
solids are not saved — opening the project stages the bodies on the kernel
again and builds the part.

### Layout

- `core/` — `kernel.ts` wraps `occt-wasm` to ~25 operations; `frame.ts`,
  `sketch2d.ts`, `solver2d.ts` are pure and Node-testable; `part.ts` is the
  feature model; `build.ts` compiles the list to bodies; `service.ts`
  answers the protocol, in the worker (`kernelWorker.ts`) and in-thread
  (`cadLocal.ts`) alike.
- `state/cadStore.ts` — the list, the bodies, the tools, the view switches.
- `app/` — `cadSession.ts` (the builds, the scene, the staged bodies),
  `cadCommands.ts` (the agent's verbs), `cadExport.ts`, `useCadPlugin.tsx`,
  `projectSection.ts`.
- `ui/CadPanel.tsx`, `view/cadScene.ts`, `guides/cad.md`.

The plugin shares the kernel and nothing else: it imports no other plugin
(the boundary check, `scripts/check-plugin-boundary.mjs`, holds).
