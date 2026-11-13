// SPDX-License-Identifier: AGPL-3.0-only
// What the CAD workspace draws in the viewport: the part's bodies as
// shaded solids with their edges, and the sketches' settled outlines
// standing on their planes. The bodies come from the kernel through the
// worker as meshes; this draws them, in the part's frame beside the scan,
// on a layer of its own.
//
// Picking: the bodies answer clicks, giving back the feature that made the
// body and the point on it — the point a fillet names as "the edge nearest
// here", the face a shell opens through.

import * as THREE from 'three'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'
import { applyFinish, type ViewTheme } from '../../../src/viewer/viewThemes'
import type { BuiltShape } from '../core/types'
import type { DrawProfile } from '../core/protocol'

/** The solid: machined metal, blue-green, sat low so the theme's finish
 *  does the shaping. */
const SOLID_COLOR = 0x8fb7d9
const SELECT_COLOR = 0xffc46b
/** A sketch's outline: the orange the app's flat measure draws in. */
const SKETCH_COLOR = 0xff9a3c

export class CadScene {
  private host: SceneLayerHost
  private removeLayer: () => void
  private group = new THREE.Group()
  private solidMat: THREE.MeshStandardMaterial
  private selectMat: THREE.MeshStandardMaterial
  private edgeMat: THREE.LineBasicMaterial
  private sketchMat: THREE.LineBasicMaterial
  private bodies = new Map<number, { mesh: THREE.Mesh; edges: THREE.LineSegments }>()
  private sketchLines: THREE.LineLoop[] = []

  /** A click on a body: its feature id, and the point on it. */
  onBodyPick: ((id: number, point: [number, number, number]) => void) | null = null

  constructor(scene: SceneManager) {
    this.host = scene.layerHost()
    this.solidMat = new THREE.MeshStandardMaterial({ color: SOLID_COLOR, metalness: 0.25, roughness: 0.5 })
    this.selectMat = new THREE.MeshStandardMaterial({ color: SELECT_COLOR, metalness: 0.25, roughness: 0.45 })
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x1c2733, transparent: true, opacity: 0.5 })
    this.sketchMat = new THREE.LineBasicMaterial({ color: SKETCH_COLOR, transparent: true, opacity: 0.9 })
    this.group.name = 'cad'
    this.removeLayer = scene.addLayer(this.layer())
  }

  private layer(): SceneLayer {
    return {
      order: 12,
      click: (x, y) => {
        const hit = this.cast(x, y)
        if (!hit) return false
        const id = Number(hit.object.name.slice('cad-body-'.length))
        if (!Number.isFinite(id)) return false
        const p = hit.point
        this.onBodyPick?.(id, [p.x, p.y, p.z])
        return true
      },
      hover: (at) => {
        const over = at ? this.cast(at.x, at.y) : null
        this.host.setCursor(over ? 'pointer' : '')
        return over !== null
      },
      themeChanged: (theme: ViewTheme) => {
        applyFinish(this.solidMat, theme)
        applyFinish(this.selectMat, theme)
        this.edgeMat.color.set(theme.id === 'dark' ? 0x141c26 : 0xa9b6c2)
        this.edgeMat.needsUpdate = true
      },
      // The section view cuts the part's bodies as it cuts the scan; the
      // closing of what it opens is the app's own.
      clippingChanged: (planes, section) => {
        const mat = [this.solidMat, this.selectMat]
        for (const m of mat) {
          m.clippingPlanes = section ? planes : null
          m.needsUpdate = true
        }
      },
      // The bodies stand in the scan's frame on a group of their own; the
      // group rides the transform the app applies to that frame.
      partMoved: () => {
        // Nothing per body: the group carries them.
      },
      scanReplaced: () => {
        // A scan says nothing about the part; the part stands where it was
        // built, in the frame it was built in.
      },
      navTargets: () => [...this.bodies.values()].map((b) => b.mesh),
      // No scan loaded, a part built: the camera frames the part.
      frameBox: () => {
        if (this.bodies.size === 0) return null
        const box = new THREE.Box3()
        for (const b of this.bodies.values()) box.expandByObject(b.mesh)
        return box.isEmpty() ? null : box
      },
      dispose: () => {
        this.clear()
      },
    }
  }

  /** Replace everything drawn as bodies with this build's. */
  setBodies(bodies: BuiltShape[], selected: number | null): void {
    this.clearBodies()
    for (const b of bodies) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(b.mesh.positions, 3))
      geo.setAttribute('normal', new THREE.BufferAttribute(b.mesh.normals, 3))
      geo.setIndex(new THREE.BufferAttribute(b.mesh.indices, 1))
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, b.id === selected ? this.selectMat : this.solidMat)
      mesh.name = `cad-body-${b.id}`
      // The kernel's own sampled edges, in the order it made them.
      const eg = new THREE.BufferGeometry()
      eg.setAttribute('position', new THREE.BufferAttribute(b.edges.points, 3))
      const edges = new THREE.LineSegments(eg, this.edgeMat)
      edges.name = `cad-edges-${b.id}`
      this.group.add(mesh)
      this.group.add(edges)
      this.bodies.set(b.id, { mesh, edges })
    }
    if (!this.group.parent) this.host.partGroup.add(this.group)
    this.host.invalidate()
  }

  /** Paint the selected body, leaving the rest. */
  /** The bodies as a whole, put away and shown again (the view bar's key,
   *  view.set) — kept in the part, not drawn. */
  setBodiesHidden(hidden: boolean): void {
    this.group.visible = true
    for (const b of this.bodies.values()) {
      b.mesh.visible = !hidden
      b.edges.visible = !hidden
    }
  }

  setSketchesHidden(hidden: boolean): void {
    for (const l of this.sketchLines) l.visible = !hidden
  }

  setSelected(selected: number | null): void {
    for (const [id, b] of this.bodies) b.mesh.material = id === selected ? this.selectMat : this.solidMat
    this.host.invalidate()
  }

  /** Draw sketches' settled outlines, on their planes. */
  setSketches(profiles: DrawProfile[]): void {
    for (const l of this.sketchLines) l.geometry.dispose()
    this.sketchLines = []
    for (const p of profiles) {
      // The plane as a basis: x along X, y along X×Z (the frame is
      // right-handed), z along Z; the sketch's (u, v) lies in it.
      const x = new THREE.Vector3(...p.plane.xAxis)
      const z = new THREE.Vector3(...p.plane.zAxis)
      const y = new THREE.Vector3().crossVectors(z, x).normalize()
      const origin = new THREE.Vector3(...p.plane.origin)
      for (const o of p.outlines) {
        for (const loop of [o.outline, ...o.holes]) {
          if (loop.length < 2) continue
          const pts = loop.map(([u, v]) => new THREE.Vector3(u, v, 0).applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z)).add(origin))
          const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.sketchMat)
          this.group.add(line)
          this.sketchLines.push(line)
        }
      }
    }
    if (!this.group.parent) this.host.partGroup.add(this.group)
    this.host.invalidate()
  }

  /** Nothing drawn at all. */
  clear(): void {
    this.clearBodies()
    for (const l of this.sketchLines) l.geometry.dispose()
    this.sketchLines = []
    this.group.removeFromParent()
  }

  private clearBodies(): void {
    for (const b of this.bodies.values()) {
      b.mesh.geometry.dispose()
      b.edges.geometry.dispose()
    }
    this.bodies.clear()
    for (const l of this.sketchLines) l.geometry.dispose()
    this.sketchLines = []
    this.group.clear()
  }

  private cast(clientX: number, clientY: number): THREE.Intersection | null {
    if (this.bodies.size === 0) return null
    this.host.setPickRay(clientX, clientY)
    const meshes = [...this.bodies.values()].map((b) => b.mesh)
    const hits = this.host.raycaster.intersectObjects(meshes, false)
    return hits.length > 0 ? hits[0] : null
  }

  dispose(): void {
    this.removeLayer()
    this.clear()
    for (const m of [this.solidMat, this.selectMat, this.edgeMat, this.sketchMat]) m.dispose()
  }
}
