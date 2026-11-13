// SPDX-License-Identifier: AGPL-3.0-only
// The CAD workspace's panel: the part as the list of features it is, and
// the tools that add to that list. Each row of the list opens to the
// numbers the feature is made of; every field writes the feature and
// asks for a build. What the list is, the part is.

import type { ReactNode } from 'react'
import { Icon } from '../../../src/ui/icons'
import { InfoDot } from '../../../src/ui/InfoDot'
import { useCad, nextId, starterFeatures, type CadTool } from '../state/cadStore'
import type { Feature } from '../core/part'
import { useStore } from '../../../src/state/store'
import { count, fmtVol } from './cadFormat'
import './cad.css'

const TOOLS: { id: CadTool; icon: ReactNode; label: string; title: string }[] = [
  { id: 'box', icon: <Icon name="sheet" />, label: 'Box', title: 'A box on the datum\u2019s origin — width, depth, height, standing on the plane' },
  { id: 'cylinder', icon: <Icon name="elCylinder" />, label: 'Cylinder', title: 'A cylinder standing on the datum\u2019s origin — radius and height' },
  { id: 'sphere', icon: <Icon name="elSphere" />, label: 'Sphere', title: 'A sphere centred on the datum\u2019s origin, sitting on the plane — radius' },
  { id: 'sketch', icon: <Icon name="sketch" />, label: 'Sketch', title: 'A sketch on a datum plane: a square to start, constraints settled, pulled into a solid' },
  { id: 'extrude', icon: <Icon name="extrude" />, label: 'Extrude', title: 'Pull a sketch along its normal into a solid' },
  { id: 'revolve', icon: <Icon name="revolve" />, label: 'Revolve', title: 'Spin a sketch about an axis into a solid' },
  { id: 'loft', icon: <Icon name="loft" />, label: 'Loft', title: 'Stretch a solid between the last two sketches' },
  { id: 'boolean', icon: <Icon name="combine" />, label: 'Boolean', title: 'Two bodies as one: fuse them, take one out of the other, keep what they share' },
  { id: 'fillet', icon: <Icon name="fillet" />, label: 'Fillet', title: 'Round the edges of a body to a radius — every edge, or the one nearest a point clicked on the part' },
  { id: 'chamfer', icon: <Icon name="chamfer" />, label: 'Chamfer', title: 'Bevel the edges of a body' },
  { id: 'shell', icon: <Icon name="shell" />, label: 'Shell', title: 'Hollow a body to a wall of the thickness you set, open through its top face, its bottom, or sealed' },
  { id: 'pattern', icon: <Icon name="pattern" />, label: 'Pattern', title: 'Repeat a body along a direction, a spacing, a count' },
  { id: 'mirror', icon: <Icon name="mirror" />, label: 'Mirror', title: 'Mirror a body in a datum plane and fuse the two' },
]

/** The feature a tool adds, with its sensible defaults. */
function featureFor(tool: CadTool, id: number, features: Feature[]): Feature | null {
  const bodies = features.filter((f) => f.kind !== 'sketch')
  const last = bodies[bodies.length - 1]
  const sk = [...features].reverse().find((f) => f.kind === 'sketch')
  switch (tool) {
    case 'box':
      return { id, kind: 'box', name: 'Box', width: 40, depth: 30, height: 20 }
    case 'cylinder':
      return { id, kind: 'cylinder', name: 'Cylinder', radius: 12, height: 30 }
    case 'sphere':
      return { id, kind: 'sphere', name: 'Sphere', radius: 15 }
    case 'sketch':
      return {
        id,
        kind: 'sketch',
        name: 'Sketch',
        plane: 'xy',
        on: 'datum',
        offset: 0,
        shift: [0, 0],
        entities: [
          { kind: 'line', from: [-10, -10], to: [10, -10] },
          { kind: 'line', from: [10, -10], to: [10, 10] },
          { kind: 'line', from: [10, 10], to: [-10, 10] },
          { kind: 'line', from: [-10, 10], to: [-10, -10] },
        ],
        constraints: [],
      }
    case 'extrude':
      return sk ? { id, kind: 'extrude', name: 'Extrude', sketch: sk.id, depth: 10 } : null
    case 'revolve':
      return sk ? { id, kind: 'revolve', name: 'Revolve', sketch: sk.id, angleDeg: 360, axis: 'z' } : null
    case 'loft': {
      const sketches = features.filter((f) => f.kind === 'sketch').slice(-2).map((f) => f.id)
      return sketches.length >= 2 ? { id, kind: 'loft', name: 'Loft', sketches, ruled: false } : null
    }
    case 'boolean':
      return bodies.length >= 2 ? { id, kind: 'boolean', name: 'Fuse', op: 'fuse', a: bodies[bodies.length - 2].id, b: bodies[bodies.length - 1].id } : null
    case 'fillet':
      return last ? { id, kind: 'fillet', name: 'Fillet', body: last.id, radius: 3, edges: { which: 'all' } } : null
    case 'chamfer':
      return last ? { id, kind: 'chamfer', name: 'Chamfer', body: last.id, distance: 3, edges: { which: 'all' } } : null
    case 'shell':
      return last ? { id, kind: 'shell', name: 'Shell', body: last.id, thickness: 2, open: { which: 'top' } } : null
    case 'pattern':
      return last ? { id, kind: 'linearPattern', name: 'Pattern', body: last.id, direction: [1, 0, 0], spacing: 20, count: 3 } : null
    case 'mirror':
      return last ? { id, kind: 'mirror', name: 'Mirror', body: last.id, plane: 'yz' } : null
    case 'import':
      // The panel has no import: an agent's cad.import stages a body and
      // lays its feature on the list.
      return null
  }
}

/** The numbers a feature is made of, as fields: [key, label, value]. */
function fieldsOf(f: Feature): { key: string; label: string; value: number; step?: number }[] {
  switch (f.kind) {
    case 'box':
      return [
        { key: 'width', label: 'Width', value: f.width },
        { key: 'depth', label: 'Depth', value: f.depth },
        { key: 'height', label: 'Height', value: f.height },
      ]
    case 'cylinder':
      return [
        { key: 'radius', label: 'Radius', value: f.radius },
        { key: 'height', label: 'Height', value: f.height },
      ]
    case 'sphere':
      return [{ key: 'radius', label: 'Radius', value: f.radius }]
    case 'cone':
      return [
        { key: 'radius1', label: 'Bottom radius', value: f.radius1 },
        { key: 'radius2', label: 'Top radius', value: f.radius2 },
        { key: 'height', label: 'Height', value: f.height },
      ]
    case 'torus':
      return [
        { key: 'majorRadius', label: 'Ring radius', value: f.majorRadius },
        { key: 'minorRadius', label: 'Tube radius', value: f.minorRadius },
      ]
    case 'ellipsoid':
      return [
        { key: 'rx', label: 'X radius', value: f.rx },
        { key: 'ry', label: 'Y radius', value: f.ry },
        { key: 'rz', label: 'Z radius', value: f.rz },
      ]
    case 'sketch':
      return [
        { key: 'offset', label: 'Off plane', value: f.offset },
        { key: 'sx', label: 'Slide x', value: f.shift[0] },
        { key: 'sy', label: 'Slide y', value: f.shift[1] },
      ]
    case 'extrude':
      return [{ key: 'depth', label: 'Depth', value: f.depth }]
    case 'revolve':
      return [{ key: 'angleDeg', label: 'Angle °', value: f.angleDeg, step: 15 }]
    case 'loft':
      return []
    case 'boolean':
      return []
    case 'fillet':
      return [{ key: 'radius', label: 'Radius', value: f.radius, step: 0.5 }]
    case 'chamfer':
      return [{ key: 'distance', label: 'Distance', value: f.distance, step: 0.5 }]
    case 'shell':
      return [{ key: 'thickness', label: 'Wall', value: f.thickness, step: 0.5 }]
    case 'linearPattern':
      return [
        { key: 'spacing', label: 'Spacing', value: f.spacing },
        { key: 'count', label: 'Times', value: f.count, step: 1 },
      ]
    case 'circularPattern':
      return [
        { key: 'count', label: 'Times', value: f.count, step: 1 },
        { key: 'angleDeg', label: 'Angle °', value: f.angleDeg, step: 15 },
      ]
    case 'mirror':
      return []
    case 'component':
      return [
        { key: 'tx', label: 'Move x', value: f.placement.translation[0] },
        { key: 'ty', label: 'Move y', value: f.placement.translation[1] },
        { key: 'tz', label: 'Move z', value: f.placement.translation[2] },
      ]
  }
}

const SKETCH_PLANES = ['xy', 'yx', 'xz', 'zx', 'yz', 'zy'] as const
const BOOLEAN_OPS = ['fuse', 'cut', 'intersect'] as const
const SHELL_OPEN = ['top', 'bottom', 'none'] as const
const PATTERN_DIRS: [string, [number, number, number]][] = [
  ['X', [1, 0, 0]],
  ['Y', [0, 1, 0]],
  ['Z', [0, 0, 1]],
]

export function CadPanel({ onExport }: { onExport: (format: 'step' | 'stl') => void }) {
  const features = useCad((s) => s.features)
  const setFeatures = useCad((s) => s.setFeatures)
  const status = useCad((s) => s.status)
  const step = useCad((s) => s.step)
  const message = useCad((s) => s.message)
  const selected = useCad((s) => s.selected)
  const editing = useCad((s) => s.editing)
  const tool = useCad((s) => s.tool)
  const setTool = useCad((s) => s.setTool)
  const setEditing = useCad((s) => s.setEditing)
  const setSelected = useCad((s) => s.setSelected)
  const results = useCad((s) => s.results)
  const bodies = useCad((s) => s.bodies)
  const fileName = useStore((s) => s.fileName)

  const add = (t: CadTool) => {
    const f = featureFor(t, nextId(features), features)
    if (!f) return
    setFeatures([...features, f])
    setEditing(f.id)
    setTool(null)
  }

  const patch = (id: number, key: string, value: number | string) => {
    setFeatures(
      features.map((f) => {
        if (f.id !== id) return f
        if (key === 'plane' && f.kind === 'sketch') return { ...f, plane: value as (typeof SKETCH_PLANES)[number] }
        if (key === 'op' && f.kind === 'boolean') return { ...f, op: value as (typeof BOOLEAN_OPS)[number] }
        if (key === 'open' && f.kind === 'shell') return { ...f, open: { which: value as (typeof SHELL_OPEN)[number] } }
        if (key === 'dir' && f.kind === 'linearPattern') {
          const dir = PATTERN_DIRS.find((d) => d[0] === value)?.[1] ?? f.direction
          return { ...f, direction: dir }
        }
        if ((key === 'sx' || key === 'sy') && f.kind === 'sketch') {
          const shift: [number, number] = [...f.shift]
          shift[key === 'sx' ? 0 : 1] = value as number
          return { ...f, shift }
        }
        return { ...f, [key]: value } as Feature
      }),
    )
  }

  const remove = (id: number) => {
    setFeatures(features.filter((f) => f.id !== id).map((f) => (f.id > id ? ({ ...f, id: f.id - 1 } as Feature) : f)))
  }

  const move = (id: number, d: -1 | 1) => {
    const i = features.findIndex((f) => f.id === id)
    const j = i + d
    if (i < 0 || j < 0 || j >= features.length) return
    const list = [...features]
    ;[list[i], list[j]] = [list[j], list[i]]
    setFeatures(list)
  }

  const featureOk = (f: Feature) => {
    const at = features.findIndex((x) => x.id === f.id)
    const r = results.find((x) => x.index === at)
    return r ? r.ok : null
  }

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          <span>Part</span>
          <InfoDot title="The list is the part">Built in order, feature by feature; a project saves the list, and the part is built again from it. Click a body in the viewport to select the feature that made it.</InfoDot>
        </div>
        {features.length === 0 ? (
          <div className="cad-empty">
            <p className="hint" data-test="cad-empty">
              Nothing on the part yet. A primitive, a sketch, an import — the first feature is where it starts.
            </p>
            <button className="btn small" onClick={() => setFeatures(starterFeatures())} data-test="cad-starter">
              <Icon name="sheet" /> Starter box
            </button>
          </div>
        ) : (
          <div className="cad-features" data-test="cad-features">
            {features.map((f) => {
              const ok = featureOk(f)
              const body = bodies.get(f.id)
              return (
                <div key={f.id} className={`cad-feature${selected === f.id ? ' on' : ''}`} data-test="cad-feature">
                  <div className="cad-feature-head">
                    <button className="cad-name" onClick={() => setSelected(f.id)} title={f.name}>
                      {f.name}
                    </button>
                    <span className={`cad-ok${ok === false ? ' bad' : ''}`}>{ok === false ? '✕' : body ? `${fmtVol(body.volume)}` : ''}</span>
                    <button className="icobtn" title="Move up" onClick={() => move(f.id, -1)} disabled={features[0].id === f.id}>
                      <Icon name="rotateCcw" />
                    </button>
                    <button className="icobtn" title="Move down" onClick={() => move(f.id, 1)} disabled={features[features.length - 1].id === f.id}>
                      <Icon name="rotateCw" />
                    </button>
                    <button className="icobtn" title="Remove" onClick={() => remove(f.id)} data-test="cad-remove">
                      <Icon name="bin" />
                    </button>
                  </div>
                  {editing === f.id && (
                    <div className="cad-fields" data-test="cad-fields">
                      {f.kind === 'sketch' && (
                        <label className="cad-field">
                          <span>Plane</span>
                          <select value={f.plane} onChange={(e) => patch(f.id, 'plane', e.target.value)}>
                            {SKETCH_PLANES.map((p) => (
                              <option key={p} value={p}>
                                {p.toUpperCase()}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {f.kind === 'boolean' && (
                        <label className="cad-field">
                          <span>Op</span>
                          <select value={f.op} onChange={(e) => patch(f.id, 'op', e.target.value)}>
                            {BOOLEAN_OPS.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {f.kind === 'shell' && (
                        <label className="cad-field">
                          <span>Open</span>
                          <select value={f.open.which} onChange={(e) => patch(f.id, 'open', e.target.value)}>
                            {SHELL_OPEN.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {f.kind === 'linearPattern' && (
                        <label className="cad-field">
                          <span>Direction</span>
                          <select value={PATTERN_DIRS.find((d) => d[1] === f.direction)?.[0] ?? 'X'} onChange={(e) => patch(f.id, 'dir', e.target.value)}>
                            {PATTERN_DIRS.map((d) => (
                              <option key={d[0]} value={d[0]}>
                                {d[0]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {fieldsOf(f).map((fl) => (
                        <label className="cad-field" key={fl.key}>
                          <span>{fl.label}</span>
                          <input
                            type="number"
                            value={fl.value}
                            step={fl.step ?? 0.5}
                            onChange={(e) => patch(f.id, fl.key, Number(e.target.value))}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="group">
        <div className="sec-head">
          <span>Add</span>
        </div>
        <div className="kindrow featurekeys" role="radiogroup" aria-label="CAD feature">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={tool === t.id}
              title={t.title}
              className={tool === t.id ? 'on' : undefined}
              onClick={() => add(t.id)}
              data-test={`cad-tool-${t.id}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <p className="hint">The list is the part. A sketch starts as a square; its constraints solve before it is pulled.</p>
      </div>

      {message && (
        <div className="group" data-test="cad-message">
          <p className="hint warn">{message}</p>
        </div>
      )}

      <div className="group">
        <div className="sec-head">
          <span>Build</span>
        </div>
        <div className="kv" data-test="cad-status">
          <span className="name">Kernel</span>
          <span className="value">{status === 'building' ? (step ?? 'working…') : status === 'failed' ? 'fault' : status === 'ready' ? 'ready' : 'idle'}</span>
        </div>
        <div className="kv">
          <span className="name">Features</span>
          <span className="value">{count(features.length)}</span>
        </div>
        {fileName && (
          <div className="kv">
            <span className="name">Scan beside</span>
            <span className="value">{fileName}</span>
          </div>
        )}
        <div className="cad-export">
          <button className="btn small" onClick={() => onExport('step')} data-test="cad-export-step">
            <Icon name="exportStep" /> STEP
          </button>
          <button className="btn small" onClick={() => onExport('stl')} data-test="cad-export-stl">
            <Icon name="exportStep" /> STL
          </button>
        </div>
      </div>
    </aside>
  )
}
