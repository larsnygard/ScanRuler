# Modelling a part in the CAD workspace

The CAD workspace builds a solid part from a list of parametric features, in
order, with the OCCT kernel. It needs no scan: the part grows from its first
feature. The same list the panel shows is what the commands change — one code
path.

## The shape of the part

- The part is `cad.status`'s `features`: an ordered list. Every feature is an
  index in that list; a later feature names the ones it reads (`sketch`,
  `body`, `a`/`b`). `cad.remove` takes a feature and everything made of it.
- Primitives: `cad.box`, `cad.cylinder`, `cad.sphere` (the list's
  `cone`/`torus`/`ellipsoid` kinds are settable through `cad.set` too).
- Sketches: `cad.sketch` lays closed wires (rectangles, circles, polygons) on
  a datum plane (`xy`/`xz`/`yz`, an `offset` and a `shift`), and
  `cad.extrude` / `cad.revolve` pull them into solids. `cad.loft` stretches
  between two or more sketches.
- Booleans: `cad.boolean` with `op` `fuse` / `cut` / `intersect` over two
  body indices.
- Dress: `cad.fillet` / `cad.chamfer` (edges: `all`, or `nearest` a point in
  the part), `cad.shell` (`thickness`, opened through `top` / `bottom` /
  `none`), `cad.pattern` (linear along a direction, circular about an axis),
  and the list's `mirror` kind.
- `cad.import` stages a STEP/STL body beside the part and lays a `component`
  feature on the list with a `placement` — a body read, not a feature grown.
- `cad.set` edits one feature's numbers by index — every field a feature
  carries is editable. `cad.export` writes the part (all bodies, or the ids
  named) as STEP/STL/3MF.

## How to work

- Each change is one undo step, labelled by the command; a change that
  throws leaves the list as it was. No separate commit — the command is the
  step.
- Build after every change is automatic; `cad.status` answers `building`
  while it runs and the part with `bodies` (volume, bounding box) when it
  stands. Await it: read `cad.status` before deciding the next feature.
- A feature that fails to build reports its reason in `cad.status`
  (`failures`) and stops the list there: the features after it did not run.
  Fix it with `cad.set` or take it away with `cad.remove`; the part before it
  stands.
- Fillet/chamfer `nearest` wants a point on the edge you mean — take it from
  a body's bounding box or a sketch's coordinates; a point near the middle
  of a long edge picks it.
- Booleans read two body indices: the solid a feature made is that feature's
  index in the list. A sketch is a profile, not a body — `extrude` it first.
- Units are millimetres throughout. The kernel speaks one unit.
- A part is small: keep features few and numbers round, the way you would
  model it by hand. Read the answer, then move on.

## The kernel's habits

- The kernel loads on the first build (~10 MB, one time). A command that
  starts the load waits for it.
- Volumes are cm³ in the answers, mm in the inputs.
- `cad.reset` takes the part away (the list, the kernel's bodies). The
  kernel is loaded again on the next feature.

## Before a handover

- `cad.status` shows the list, the bodies and their volumes, and the
  failures. A part is handed over with `cad.export` — STEP when the part
  goes back to CAD, STL when it goes to a printer.
- The project file saves the list and the imported bodies, not the solids:
  opening a project builds the part again.
