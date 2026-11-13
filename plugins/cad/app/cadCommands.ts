// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace's commands — what an agent models a part through
// (src/commands), registered under the workspace's id `cad`: cad.box,
// cad.extrude, cad.fillet and the rest. Each is the panel's own code
// path: the feature added to the list as the panel's key adds it, the
// list written through the store as the panel's fields write it, the
// build awaited, and what came of it handed back — one step of the undo
// history ("Agent: …"). A command that fails leaves the list as it was.

import { CommandError, type Command } from '../../../src/plugins/api'
import { arr, bool, bytes, enumOf, int, num, obj, oneOf, str, vec3, type JsonSchema } from '../../../src/commands/schema'
import { invalid } from '../../../src/commands/core/common'
import { cadSession } from './cadSession'
import { nextId, useCad } from '../state/cadStore'
import { featureJson, type BooleanOp, type EdgeSelection, type FaceSelection, type Feature } from '../core/part'
import type { DatumPlane, SketchEntity } from '../core/types'

const c = () => useCad.getState()

function session() {
  const s = cadSession()
  if (!s) throw new CommandError('unavailable', 'The CAD workspace is not set up in this session.')
  return s
}

/** The list as it must stand, changed as a verb changes it, built, and
 *  every feature's outcome handed back. The verb makes the list; a list
 *  that stands as it was is refused. The run sits inside the registry's
 *  history step (its label, "Agent: …"): the change is the step, the
 *  build awaited, so the answer speaks of the part as it stands. */
async function apply(make: (features: Feature[]) => Feature[] | null) {
  const s = session()
  const before = c().features
  const next = make(structuredClone(before))
  if (next === null) throw new CommandError('invalid_input', 'Nothing to do: the part holds no body for the verb to read.')
  if (JSON.stringify(next.map(featureJson)) === JSON.stringify(before.map(featureJson))) {
    invalid('The part already stands as the command asks for it.')
  }
  const added = next.length - before.length
  c().setFeatures(next)
  // The store's subscription asks the session for a build; await the
  // session's own promise, so the answer is the part as it will stand.
  await s.build()
  const st = c()
  const built = st.results.filter((r) => r.ok).length
  return {
    features: st.features.map((f, i) => ({
      index: i,
      id: f.id,
      kind: f.kind,
      name: f.name,
      ok: st.results[i]?.ok ?? false,
      ...(st.results[i] && !st.results[i]!.ok ? { reason: (st.results[i] as { reason: string }).reason } : {}),
    })),
    ...(added > 0 ? { added } : {}),
    built,
    blocked: st.features.length - built,
    ...(st.message ? { message: st.message } : {}),
  }
}

/** The bodies as the agent reads them: volume, area, bounds, closed. */
function bodiesOut() {
  const st = c()
  return [...st.bodies.values()].map((b) => ({
    id: b.id,
    name: b.name,
    volume: Math.round(b.volume * 1000) / 1000,
    area: Math.round(b.area * 1000) / 1000,
    closed: b.closed,
    bounds: { min: b.bounds.min, max: b.bounds.max },
  }))
}

/** A feature by index, checked in: a sketch for what reads sketches, a
 *  body for what reads bodies. */
function requireId(features: Feature[], id: number, what: 'sketch' | 'body' | 'feature'): number {
  const at = features.findIndex((f) => f.id === id)
  if (at < 0) invalid(`There is no feature ${id} on the part — cad.status tells what there is.`)
  const kind = features[at].kind
  if (what === 'sketch' && kind !== 'sketch') invalid(`Feature ${id} is a ${kind}, not a sketch.`)
  if (what === 'body' && kind === 'sketch') invalid(`Feature ${id} is a sketch, not a body.`)
  return id
}

const noInput = obj({}, [])
const featureSchema = int('The feature: its place in the list (0, 1, …).')
const datumEnum = (what: string) => enumOf(['xy', 'yx', 'xz', 'zx', 'yz', 'zy'] as const, what)
const edgesSel: JsonSchema = oneOf(
  [obj({ which: enumOf(['all'] as const) }, ['which']), obj({ which: enumOf(['nearest'] as const), point: vec3('The point in the part the edge lies nearest to.') }, ['which', 'point'])],
  'Which edges: all of them, or the one nearest a point in the part (cad.status bounds hand points; a body clicked in the viewport hands one back).',
)
const faceSel: JsonSchema = oneOf(
  [obj({ which: enumOf(['top', 'bottom', 'none'] as const) }, ['which'])],
  'The face the shell opens through: the topmost, the bottommost, or none — a sealed cavity.',
)
const nameField = str('What to call it on the part.')

// ---- the commands ------------------------------------------------------------------

const status: Command = {
  name: 'status',
  title: 'Read the CAD part',
  description:
    'The CAD workspace as it stands: the feature list with each feature’s kind, name and whether it built, the bodies last built with volume, area, bounds and whether each is closed, what a build is at, and the last word it said. The readout a modelling session starts and ends on. Changes nothing.',
  input: noInput,
  readOnly: true,
  run: async () => {
    const st = c()
    return {
      name: st.name,
      status: st.status,
      ...(st.step ? { step: st.step } : {}),
      ...(st.message ? { message: st.message } : {}),
      features: st.features.map((f, i) => ({ index: i, id: f.id, kind: f.kind, name: f.name, ok: st.results[i]?.ok ?? null })),
      bodies: bodiesOut(),
    }
  },
}

const reset: Command = {
  name: 'reset',
  title: 'Take the part away',
  description:
    'Empty the CAD part: the feature list is taken away and the kernel let go. The undo history keeps the part as it was — an undo puts the list back and builds it again.',
  input: noInput,
  run: async () => {
    const s = session()
    const st = c()
    if (st.features.length === 0) return { features: [] }
    // The registry's history step wraps this run: the change is the step.
    st.setFeatures([])
    await s.reset().catch(() => null)
    return { features: [] }
  },
}

const box: Command<{ width?: number; depth?: number; height?: number; name?: string }> = {
  name: 'box',
  title: 'Add a box',
  description:
    'Add a box to the CAD part, on the datum’s origin, standing on the plane: width along X, depth along Y, height along Z, millimetres. It is built at once; every feature’s outcome comes back, and the body’s volume with cad.status next time. One command, one feature: a plate with a rib is a box, a second box, a fuse.',
  input: obj({ width: num('Width in mm, along X.', { exclusiveMinimum: 0 }), depth: num('Depth in mm, along Y.', { exclusiveMinimum: 0 }), height: num('Height in mm, along Z.', { exclusiveMinimum: 0 }), name: nameField }),
  run: async ({ width, depth, height, name }) => {
    for (const [v, what] of [[width, 'width'], [depth, 'depth'], [height, 'height']] as const) {
      if (v !== undefined && !(v > 0)) invalid(`The ${what} must be more than zero.`)
    }
    return apply((features) => {
      features.push({ id: nextId(features), kind: 'box', name: name || 'Box', width: width ?? 40, depth: depth ?? 30, height: height ?? 20 })
      return features
    })
  },
}

const cylinder: Command<{ radius?: number; height?: number; name?: string }> = {
  name: 'cylinder',
  title: 'Add a cylinder',
  description:
    'Add a cylinder to the CAD part, standing on the datum’s origin (its axis along Z): radius and height in millimetres. Built at once.',
  input: obj({ radius: num('Radius in mm, over zero.', { exclusiveMinimum: 0 }), height: num('Height in mm, over zero.', { exclusiveMinimum: 0 }), name: nameField }),
  run: async ({ radius, height, name }) =>
    apply((features) => {
      features.push({ id: nextId(features), kind: 'cylinder', name: name || 'Cylinder', radius: radius ?? 12, height: height ?? 30 })
      return features
    }),
}

const sphere: Command<{ radius?: number; name?: string }> = {
  name: 'sphere',
  title: 'Add a sphere',
  description: 'Add a sphere to the CAD part, centred on the datum’s origin: radius in millimetres. Built at once.',
  input: obj({ radius: num('Radius in mm, over zero.', { exclusiveMinimum: 0 }), name: nameField }),
  run: async ({ radius, name }) =>
    apply((features) => {
      features.push({ id: nextId(features), kind: 'sphere', name: name || 'Sphere', radius: radius ?? 15 })
      return features
    }),
}

const sketch: Command<{ plane?: DatumPlane; offset?: number; shift?: [number, number]; entities: { from?: [number, number]; to?: [number, number]; center?: [number, number]; radius?: number }[]; name?: string }> = {
  name: 'sketch',
  title: 'Add a sketch',
  description:
    'Add a closed profile to the CAD part, on a datum plane (xy the floor, xz a front wall, yz a side; the second letter the normal: xy faces up), slid by shift within it and pushed off it by an offset. entities are lines {from:[x,y], to:[x,y]} and circles {center:[x,y], radius} in the plane’s coordinates. A rectangle of four lines closes its corners when built; a circle lying within one outline is a hole. The profile is what cad.extrude pulls, by the feature’s index. Built at once; the sketch’s residuals say what a constraint could not settle.',
  input: obj(
    {
      plane: datumEnum('The datum plane the sketch lies on; default xy.'),
      offset: num('How far off the plane, along its normal, mm; default 0.'),
      shift: arr(num(), 'Within-plane [x, y].', { minItems: 2, maxItems: 2 }),
      entities: arr(
        oneOf([obj({ from: arr(num(), '', { minItems: 2, maxItems: 2 }), to: arr(num(), '', { minItems: 2, maxItems: 2 }) }, ['from', 'to']), obj({ center: arr(num(), '', { minItems: 2, maxItems: 2 }), radius: num('The circle’s radius, mm.', { exclusiveMinimum: 0 }) }, ['center', 'radius'])]),
        'The profile: lines and circles, in the plane’s coordinates.',
        { minItems: 1 },
      ),
      name: nameField,
    },
    ['entities'],
  ),
  run: async ({ plane, offset, shift, entities, name }) => {
    const made: SketchEntity[] = entities.map((e) => {
      if (e.from && e.to) return { kind: 'line', from: e.from, to: e.to }
      if (e.center && e.radius) return { kind: 'circle', center: e.center, radius: e.radius }
      return invalid('An entity is a line (from, to) or a circle (center, radius).')
    })
    return apply((features) => {
      features.push({
        id: nextId(features),
        kind: 'sketch',
        name: name || 'Sketch',
        plane: plane ?? 'xy',
        on: 'datum',
        offset: offset ?? 0,
        shift: shift ?? [0, 0],
        entities: made,
        constraints: [],
      })
      return features
    })
  },
}

const extrude: Command<{ sketch: number; depth: number; name?: string }> = {
  name: 'extrude',
  title: 'Pull a sketch into a solid',
  description:
    'Pull a sketch along its normal into a solid: the sketch’s feature index and the depth in millimetres (negative extrudes the other way, through the plane). The sketch closes and the profile is pulled at once. A plate is a sketch of a rectangle extruded 10; a bore through it, a circle sketch extruded and cad.boolean cut.',
  input: obj({ sketch: featureSchema, depth: num('Depth in mm; negative through the plane.'), name: nameField }, ['sketch', 'depth']),
  run: async ({ sketch, depth, name }) => {
    if (depth === 0) invalid('The depth is zero — the pad would be nothing.')
    return apply((features) => {
      requireId(features, sketch, 'sketch')
      features.push({ id: nextId(features), kind: 'extrude', name: name || 'Extrude', sketch, depth })
      return features
    })
  },
}

const boolean: Command<{ op: 'fuse' | 'cut' | 'intersect'; a: number; b: number; name?: string }> = {
  name: 'boolean',
  title: 'Two bodies as one',
  description:
    'Fuse two bodies, take b out of a, keep what a and b share — by their feature indices. The result is a new feature; the two read stay on the part. A bore through a plate is a cylinder cut from the plate (a the plate, b the cylinder).',
  input: obj({ op: enumOf(['fuse', 'cut', 'intersect'] as const, 'fuse joins, cut takes b out of a, intersect keeps what they share.'), a: featureSchema, b: featureSchema, name: nameField }, ['op', 'a', 'b']),
  run: async ({ op, a, b, name }) => {
    if (a === b) invalid('The two bodies are one and the same feature.')
    return apply((features) => {
      requireId(features, a, 'body')
      requireId(features, b, 'body')
      features.push({ id: nextId(features), kind: 'boolean', name: name || (op === 'fuse' ? 'Fuse' : op[0].toUpperCase() + op.slice(1)), op: op as BooleanOp, a, b })
      return features
    })
  },
}

const fillet: Command<{ body: number; radius: number; edges?: EdgeSelection; name?: string }> = {
  name: 'fillet',
  title: 'Round the edges',
  description:
    'Round the edges of a body to a radius: its feature index, the radius in mm, and which edges — all of them, or the one nearest a point in the part (a body clicked in the viewport hands the point back). A radius that does not fit fails that feature alone, saying why; the rest of the part stands built.',
  input: obj({ body: featureSchema, radius: num('The radius, mm, over zero.', { exclusiveMinimum: 0 }), edges: edgesSel, name: nameField }, ['body', 'radius']),
  run: async ({ body, radius, edges, name }) =>
    apply((features) => {
      requireId(features, body, 'body')
      features.push({ id: nextId(features), kind: 'fillet', name: name || 'Fillet', body, radius, edges: edges ?? { which: 'all' } })
      return features
    }),
}

const chamfer: Command<{ body: number; distance: number; edges?: EdgeSelection; name?: string }> = {
  name: 'chamfer',
  title: 'Bevel the edges',
  description: 'Bevel the edges of a body: its feature index, the set-back distance in mm, and which edges (all, or nearest a point). One feature; the body it reads stays standing.',
  input: obj({ body: featureSchema, distance: num('The set-back, mm, over zero.', { exclusiveMinimum: 0 }), edges: edgesSel, name: nameField }, ['body', 'distance']),
  run: async ({ body, distance, edges, name }) =>
    apply((features) => {
      requireId(features, body, 'body')
      features.push({ id: nextId(features), kind: 'chamfer', name: name || 'Chamfer', body, distance, edges: edges ?? { which: 'all' } })
      return features
    }),
}

const shell: Command<{ body: number; thickness: number; open?: FaceSelection; name?: string }> = {
  name: 'shell',
  title: 'Hollow the body',
  description:
    'Hollow a body to a wall of a set thickness, open through a face (the topmost, the bottommost, or none — a sealed cavity): its feature index, wall in mm, opening. A shelled box is a lid, a housing, a printed shell.',
  input: obj({ body: featureSchema, thickness: num('The wall, mm, over zero.', { exclusiveMinimum: 0 }), open: faceSel, name: nameField }, ['body', 'thickness']),
  run: async ({ body, thickness, open, name }) =>
    apply((features) => {
      requireId(features, body, 'body')
      features.push({ id: nextId(features), kind: 'shell', name: name || 'Shell', body, thickness, open: open ?? { which: 'top' } })
      return features
    }),
}

const pattern: Command<{ body: number; kind: 'linear' | 'circular' | 'mirror'; direction?: [number, number, number]; spacing?: number; count?: number; center?: [number, number, number]; axis?: 'x' | 'y' | 'z'; angleDeg?: number; plane?: DatumPlane; name?: string }> = {
  name: 'pattern',
  title: 'Repeat a body',
  description:
    'Repeat a body: along a direction, spacing and count (linear), about an axis at an angle (circular), or once mirrored in a datum plane (mirror) — by the body’s feature index. The copies fuse with the original: a bolt circle is a circular pattern of a bore, a butterfly is a mirror.',
  input: obj({
    body: featureSchema,
    kind: enumOf(['linear', 'circular', 'mirror'] as const),
    direction: vec3('Linear: the direction to repeat along — an axis, [1,0,0], says it plainly.'),
    spacing: num('Linear: from one copy to the next, mm.', { exclusiveMinimum: 0 }),
    count: int('Times (linear and circular); at least two.', { minimum: 2, maximum: 200 }),
    center: vec3('Circular: the point the axis stands at.'),
    axis: enumOf(['x', 'y', 'z'] as const, 'Circular: the axis.'),
    angleDeg: num('Circular: the angle swept — 360 the full ring, 90 a quarter.'),
    plane: datumEnum('Mirror: the datum plane mirrored in.'),
    name: nameField,
  }, ['body', 'kind']),
  run: async ({ body, kind, direction, spacing, count, center, axis, angleDeg, plane, name }) =>
    apply((features) => {
      requireId(features, body, 'body')
      const id = nextId(features)
      const nm = name || (kind === 'linear' ? 'Pattern' : kind === 'circular' ? 'Circular pattern' : 'Mirror')
      if (kind === 'linear') {
        const dir = direction ?? [1, 0, 0]
        if (dir.every((v) => v === 0)) invalid('The direction is zero — name an axis.')
        features.push({ id, kind: 'linearPattern', name: nm, body, direction: dir, spacing: spacing ?? 20, count: count ?? 3 })
      } else if (kind === 'circular') {
        features.push({ id, kind: 'circularPattern', name: nm, body, center: center ?? [0, 0, 0], axis: axis ?? 'z', angleDeg: angleDeg ?? 360, count: count ?? 6 })
      } else {
        features.push({ id, kind: 'mirror', name: nm, body, plane: plane ?? 'yz' })
      }
      return features
    }),
}

const revolve: Command<{ sketch: number; axis?: 'x' | 'y' | 'z'; angleDeg?: number; name?: string }> = {
  name: 'revolve',
  title: 'Spin a sketch into a solid',
  description:
    'Spin a sketch about an axis into a solid (360 a full turn — a turned part; 90 a quarter): the sketch’s feature index, the axis, the angle. The profile is spun at once; the axis lies in the sketch’s plane.',
  input: obj({ sketch: featureSchema, axis: enumOf(['x', 'y', 'z'] as const, 'The axis spun about, in the sketch’s plane.'), angleDeg: num('The angle swept, degrees.', { exclusiveMinimum: 0, maximum: 360 }), name: nameField }, ['sketch']),
  run: async ({ sketch, axis, angleDeg, name }) =>
    apply((features) => {
      requireId(features, sketch, 'sketch')
      features.push({ id: nextId(features), kind: 'revolve', name: name || 'Revolve', sketch, angleDeg: angleDeg ?? 360, axis: axis ?? 'z' })
      return features
    }),
}

const loft: Command<{ sketches: number[]; ruled?: boolean; name?: string }> = {
  name: 'loft',
  title: 'Stretch a solid between sketches',
  description:
    'Stretch a solid between sketches (their feature indices, at least two): each settled outline to the next. Two squares of a different size make a frustum; two circles, a cone. ruled straight ruled walls, not smoothed.',
  input: obj({ sketches: arr(featureSchema, 'The sketches, first to last.', { minItems: 2 }), ruled: bool('Straight ruled walls, not smoothed.'), name: nameField }, ['sketches']),
  run: async ({ sketches, ruled, name }) =>
    apply((features) => {
      for (const s of sketches) requireId(features, s, 'sketch')
      features.push({ id: nextId(features), kind: 'loft', name: name || 'Loft', sketches, ruled: ruled ?? false })
      return features
    }),
}

const set: Command<{ feature: number; width?: number; depth?: number; height?: number; radius?: number; distance?: number; thickness?: number; spacing?: number; count?: number; angleDeg?: number; offset?: number; plane?: DatumPlane; shift?: [number, number]; direction?: [number, number, number]; name?: string }> = {
  name: 'set',
  title: "Change a feature's numbers",
  description:
    "Change the numbers a feature on the CAD part is made of — a box's width, an extrude's depth, a fillet's radius — and build the part again: the feature's index and the fields it has (a box: width, depth, height; a cylinder: radius, height; a sketch: plane, offset, shift; an extrude: depth; a fillet: radius; a shell: thickness; a pattern: spacing, count, angleDeg; and so on), name to rename it. The one way a model is edited — the list is the part, and everything downstream rebuilds. A field for a feature that has none fails the command and leaves the list as it was. Returns every feature's outcome.",
  input: obj({ feature: featureSchema, width: num(), depth: num(), height: num(), radius: num(), distance: num(), thickness: num(), spacing: num(), count: int('', { minimum: 1, maximum: 200 }), angleDeg: num(), offset: num(), plane: datumEnum(''), shift: arr(num(), '', { minItems: 2, maxItems: 2 }), direction: vec3(''), name: str('Rename the feature.') }, ['feature']),
  run: async (p) => {
    const id = p.feature
    const keys = ['width', 'depth', 'height', 'radius', 'distance', 'thickness', 'spacing', 'count', 'angleDeg', 'offset', 'plane', 'shift', 'direction', 'name'] as const
    const given = keys.filter((k) => p[k] !== undefined)
    if (given.length === 0) invalid('Name at least one field to change.')
    return apply((features) => {
      requireId(features, id, 'feature')
      const f = features.find((x) => x.id === id)!
      for (const k of given) {
        const v = p[k] as number | string | [number, number] | [number, number, number]
        if (k === 'plane' && f.kind === 'sketch') f.plane = v as DatumPlane
        else if (k === 'shift' && f.kind === 'sketch') f.shift = v as [number, number]
        else if (k === 'direction' && f.kind === 'linearPattern') f.direction = v as [number, number, number]
        else if (k === 'name') (f as { name: string }).name = v as string
        else if (k in f && typeof (f as Record<string, unknown>)[k] === typeof v) (f as Record<string, unknown>)[k] = v
        else invalid(`Feature ${id} (${f.kind}) has no ${k} to change.`)
      }
      return features
    })
  },
}

const remove: Command<{ feature: number }> = {
  name: 'remove',
  title: 'Take a feature away',
  description:
    'Take a feature off the CAD part by its index, and everything made of it with it: the list closes the gap, the indices renumber, and the part is built again.',
  input: obj({ feature: featureSchema }, ['feature']),
  run: async ({ feature }) =>
    apply((features) => {
      requireId(features, feature, 'feature')
      const doomed = new Set<number>([feature])
      let grew = true
      while (grew) {
        grew = false
        for (const f of features) {
          if (doomed.has(f.id)) continue
          // A component's body is a staged key, not a feature index; it
          // stands on its own and is not swept by a removal.
          const deps =
            f.kind === 'extrude' || f.kind === 'revolve'
              ? [f.sketch]
              : f.kind === 'loft'
                ? f.sketches
                : f.kind === 'boolean'
                  ? [f.a, f.b]
                  : 'body' in f && f.kind !== 'component'
                    ? [f.body]
                    : []
          if (deps.some((d) => doomed.has(d))) {
            doomed.add(f.id)
            grew = true
          }
        }
      }
      const kept = features.filter((f) => !doomed.has(f.id))
      const remap = new Map<number, number>()
      kept.forEach((f, i) => remap.set(f.id, i))
      return kept.map((f) => {
        const g = { ...f, id: remap.get(f.id)! } as Feature
        if (g.kind === 'extrude' || g.kind === 'revolve') g.sketch = remap.get(g.sketch) ?? g.sketch
        if (g.kind === 'loft') g.sketches = g.sketches.map((s) => remap.get(s) ?? s)
        if (g.kind === 'boolean') {
          g.a = remap.get(g.a) ?? g.a
          g.b = remap.get(g.b) ?? g.b
        }
        if ('body' in g && g.kind !== 'component') g.body = remap.get(g.body) ?? g.body
        return g
      })
    }),
}

const exportPart: Command<{ format: 'step' | 'stl'; ids?: number[] }> = {
  name: 'export',
  title: 'The part as a file',
  description:
    "The CAD part (all bodies, or those named by feature index) as a file: STEP for CAD, STL for printing. Returns the file's bytes base64 (as every file command gives them), its name and mime. A part that stands unbuilt is built first.",
  input: obj({ format: enumOf(['step', 'stl'] as const), ids: arr(featureSchema, 'The bodies to write; by default every body standing.', { minItems: 1 }) }, ['format']),
  returnsFile: true,
  run: async ({ format, ids }) => {
    const s = session()
    if (c().bodies.size === 0 && c().features.length > 0) await s.build()
    const out = await s.client.export(format, { ids, name: c().name })
    let binary = ''
    for (let i = 0; i < out.bytes.length; i++) binary += String.fromCharCode(out.bytes[i])
    return { file: { name: out.name, mimeType: out.mime, bytes: btoa(binary) } }
  },
}

const importPart: Command<{ bytes: string; format: 'step' | 'stl' }> = {
  name: 'import',
  title: 'A body from a file',
  description:
    'A body from a STEP or STL file, laid beside the CAD part: the bytes base64 (as every file command hands them) and their format. The key the staged body gets is what the Import feature names as its body, to cad.boolean with the part. Returns the staged key, whether the body is closed, and every feature’s outcome.',
  input: obj({ bytes: bytes('The file’s contents, base64.'), format: enumOf(['step', 'stl'] as const) }, ['bytes', 'format']),
  run: async ({ bytes: b64, format }) => {
    const s = session()
    const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    const staged = await s.stage(raw, format)
    const out = await apply((features) => {
      features.push({ id: nextId(features), kind: 'component', name: 'Import', body: staged.key, placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] } })
      return features
    })
    return { ...out, staged: { key: staged.key, closed: staged.closed } }
  },
}

// The verbs run headless too: the session over the kernel in-thread needs
// no viewport, no scan, no page — sceneOf() answers null and the build
// skips the scene.
export const cadCommands = [status, reset, box, cylinder, sphere, sketch, extrude, revolve, loft, boolean, fillet, chamfer, shell, pattern, set, remove, exportPart, importPart].map((c) => ({ ...c, headless: true })) as Command<never>[]

/** What a build is at, for the busy line: a command must not run over it. */
export function cadBusy(): string | null {
  const s = useCad.getState()
  if (s.status === 'building') return s.step ? `the part is being built — ${s.step}` : 'the part is being built'
  return null
}

/** The workspace's part of the state an agent reads beside the readout. */
export function describeCad() {
  const st = useCad.getState()
  return {
    name: st.name,
    status: st.status,
    ...(st.step ? { step: st.step } : {}),
    features: st.features.length,
    built: st.results.filter((r) => r.ok).length,
    bodies: bodiesOut().length,
    ...(st.message ? { message: st.message } : {}),
  }
}
