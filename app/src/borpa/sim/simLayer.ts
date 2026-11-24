/**
 * The viewport's simulation layer: what the Sim tab draws over the model and
 * how it reads the pointer.
 *
 * The Viewport attaches it once per mount (its three.js scene, the drawn
 * Object groups, the canvas and its ray builder) and calls `beforeRender`
 * every frame. While the page is in simulation mode the layer
 *
 *  - draws the study's marks: fixed faces, loaded faces with an arrow, and
 *    the face under the pointer while faces are being picked;
 *  - draws a result in place of its Object (the Object's own drawing is
 *    hidden, not the Object: it is still picked), coloured per node;
 *  - takes left-button clicks for itself, so no modelling tool sees them, and
 *    reports the face clicked; camera buttons pass through;
 *  - shows the result's value under the pointer.
 *
 * It holds no document state: the study panel tells it what to draw.
 */

import * as THREE from 'three'
import type { Scene as WasmScene } from '../../wasm/loader'
import { rampColour } from './colourRamp'

export interface SimPick {
  object: bigint
  face: bigint
  /** Set when the face was reached through a component placement. */
  instance: bigint | undefined
}

export interface SimLayerContext {
  scene: THREE.Scene
  objectGroup: (object: bigint) => THREE.Object3D | null
  wasmScene: Pick<WasmScene, 'pick_face'>
  /** The element holding the canvas: pointer events are read here. */
  element: HTMLElement
  canvas: HTMLCanvasElement
  /** The world ray through a canvas-relative CSS pixel. */
  rayAt: (x: number, y: number) => { origin: [number, number, number]; direction: [number, number, number] }
  requestRender: () => void
}

export interface SimMark {
  /** Triangle corners, meters, 9 numbers per triangle. */
  triangles: Float32Array
  colour: number
  opacity: number
}

export interface SimArrow {
  /** Where the arrow's head touches, meters. */
  tip: [number, number, number]
  /** Unit direction the arrow points. */
  direction: [number, number, number]
  /** Length, meters. */
  length: number
  colour: number
}

export interface SimResultDrawing {
  /** Surface node positions, mm. */
  positions: Float32Array
  triangles: Uint32Array
  /** Node displacements, mm, xyz per node (or null: drawn undeformed). */
  displacement: Float32Array | null
  /** Multiplies the displacement when drawn. */
  scale: number
  /** The shown value per node, and the range the ramp spans. */
  values: Float32Array
  min: number
  max: number
  /** Drawn grey: the model changed since the run. */
  stale: boolean
}

/** Pointer travel (CSS px) below which a press and release is a click. */
const CLICK_SLOP = 5

export class SimLayer {
  readonly group = new THREE.Group()
  private ctx: SimLayerContext | null = null
  private active = false
  private hiddenObject: bigint | null = null
  /** The group we hid, to show it again. */
  private hiddenGroup: THREE.Object3D | null = null

  private readonly marksGroup = new THREE.Group()
  private readonly hoverGroup = new THREE.Group()
  private resultMesh: THREE.Mesh | null = null
  private resultValues: Float32Array | null = null

  private readonly clickListeners = new Set<(pick: SimPick | null, ev: PointerEvent) => void>()
  private readonly hoverListeners = new Set<(pick: SimPick | null) => void>()
  private probeFormat: ((value: number) => string) | null = null
  private probeLabel: HTMLDivElement | null = null
  private press: { id: number; x: number; y: number } | null = null
  private pendingMove: { x: number; y: number } | null = null
  private moveFrame = 0
  private lastHover: string | null = null

  constructor() {
    this.group.name = 'borpa-sim'
    this.group.visible = false
    this.group.add(this.marksGroup, this.hoverGroup)
  }

  /** Called by the Viewport on mount; returns the detach for its unmount. */
  attach(ctx: SimLayerContext): () => void {
    this.detach()
    this.ctx = ctx
    ctx.scene.add(this.group)
    const el = ctx.element
    el.addEventListener('pointerdown', this.onPointerDown, true)
    el.addEventListener('pointerup', this.onPointerUp, true)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)
    const label = document.createElement('div')
    label.setAttribute('data-testid', 'sim-probe')
    Object.assign(label.style, {
      position: 'absolute',
      pointerEvents: 'none',
      display: 'none',
      padding: '2px 6px',
      borderRadius: '4px',
      font: '12px var(--font-family-ui, sans-serif)',
      background: 'var(--surface-raised, rgba(20,20,20,0.85))',
      color: 'var(--text-primary, #fff)',
      border: '1px solid var(--border-subtle, rgba(255,255,255,0.2))',
      whiteSpace: 'nowrap',
      zIndex: '4',
    } satisfies Partial<CSSStyleDeclaration>)
    el.appendChild(label)
    this.probeLabel = label
    return () => {
      if (this.ctx === ctx) this.detach()
    }
  }

  private detach(): void {
    const ctx = this.ctx
    if (ctx === null) return
    this.showHiddenGroup()
    ctx.scene.remove(this.group)
    const el = ctx.element
    el.removeEventListener('pointerdown', this.onPointerDown, true)
    el.removeEventListener('pointerup', this.onPointerUp, true)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    this.probeLabel?.remove()
    this.probeLabel = null
    if (this.moveFrame !== 0) cancelAnimationFrame(this.moveFrame)
    this.moveFrame = 0
    this.ctx = null
  }

  /** Whether a viewport is attached. */
  get attached(): boolean {
    return this.ctx !== null
  }

  /** Simulation mode on or off: off, nothing is drawn and the pointer is left alone. */
  setActive(on: boolean): void {
    if (this.active === on) return
    this.active = on
    this.press = null
    if (!on) {
      this.hideProbe()
      this.emitHover(null)
    }
    this.render()
  }

  /** The Object whose own drawing is hidden (a result is drawn in its place). */
  setHiddenObject(object: bigint | null): void {
    if (this.hiddenObject === object) return
    this.showHiddenGroup()
    this.hiddenObject = object
    this.render()
  }

  private showHiddenGroup(): void {
    if (this.hiddenGroup !== null) this.hiddenGroup.visible = true
    this.hiddenGroup = null
  }

  /** Every frame, before the scene is drawn. */
  beforeRender(): void {
    this.group.visible = this.active
    const ctx = this.ctx
    if (ctx === null) return
    const wanted = this.active && this.hiddenObject !== null ? ctx.objectGroup(this.hiddenObject) : null
    if (wanted !== this.hiddenGroup) this.showHiddenGroup()
    // The renderer rebuilds an Object's group when it changes: hide whatever
    // group draws it now.
    if (wanted !== null && wanted.visible) {
      wanted.visible = false
      this.hiddenGroup = wanted
    }
  }

  private render(): void {
    this.ctx?.requestRender()
  }

  // ── Marks ────────────────────────────────────────────────────────────────

  private static clear(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child)
      child.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
  }

  private static markMesh(mark: SimMark): THREE.Mesh {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mark.triangles, 3))
    const mat = new THREE.MeshBasicMaterial({
      color: mark.colour,
      transparent: true,
      opacity: mark.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 10
    return mesh
  }

  /** The study's marks and force arrows. */
  setMarks(marks: SimMark[], arrows: SimArrow[]): void {
    SimLayer.clear(this.marksGroup)
    for (const m of marks) if (m.triangles.length > 0) this.marksGroup.add(SimLayer.markMesh(m))
    for (const a of arrows) {
      const dir = new THREE.Vector3(...a.direction)
      const tail = new THREE.Vector3(...a.tip).addScaledVector(dir, -a.length)
      const arrow = new THREE.ArrowHelper(dir, tail, a.length, a.colour, a.length * 0.3, a.length * 0.15)
      arrow.renderOrder = 11
      this.marksGroup.add(arrow)
    }
    this.render()
  }

  /** Show or hide the study's marks (hidden while a result is shown). */
  setMarksVisible(visible: boolean): void {
    if (this.marksGroup.visible === visible) return
    this.marksGroup.visible = visible
    this.render()
  }

  /** The face under the pointer while picking, or null. */
  setHoverMark(mark: SimMark | null): void {
    SimLayer.clear(this.hoverGroup)
    if (mark !== null && mark.triangles.length > 0) this.hoverGroup.add(SimLayer.markMesh(mark))
    this.render()
  }

  // ── Result ───────────────────────────────────────────────────────────────

  /** Draw a result (in place of its Object, which the caller hides), or none. */
  setResult(result: SimResultDrawing | null): void {
    if (this.resultMesh !== null) {
      this.group.remove(this.resultMesh)
      this.resultMesh.geometry.dispose()
      ;(this.resultMesh.material as THREE.Material).dispose()
      this.resultMesh = null
      this.resultValues = null
    }
    this.hideProbe()
    if (result !== null) {
      const n = result.positions.length / 3
      const pos = new Float32Array(3 * n)
      const colours = new Float32Array(3 * n)
      const span = result.max - result.min
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const u = result.displacement === null ? 0 : result.displacement[3 * i + k] * result.scale
          pos[3 * i + k] = (result.positions[3 * i + k] + u) / 1000
        }
        const c = result.stale ? [0.62, 0.62, 0.62] : rampColour(span > 0 ? (result.values[i] - result.min) / span : 0)
        colours[3 * i] = c[0]
        colours[3 * i + 1] = c[1]
        colours[3 * i + 2] = c[2]
      }
      // Flat shading (normals from screen-space derivatives): a node shared
      // by faces at an edge would otherwise smooth the edge away.
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colours, 3))
      geo.setIndex(new THREE.BufferAttribute(result.triangles, 1))
      geo.computeBoundingSphere()
      const mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        flatShading: true,
        shininess: 10,
        side: THREE.DoubleSide,
        transparent: result.stale,
        opacity: result.stale ? 0.55 : 1,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = 'borpa-sim-result'
      this.resultMesh = mesh
      this.resultValues = result.values
      this.group.add(mesh)
    }
    this.render()
  }

  /** How the value under the pointer is written; null shows none. */
  setProbeFormat(format: ((value: number) => string) | null): void {
    this.probeFormat = format
    if (format === null) this.hideProbe()
  }

  /** The value of the drawn result at a canvas point, or null off the result. */
  probeAt(x: number, y: number): number | null {
    const ctx = this.ctx
    const mesh = this.resultMesh
    const values = this.resultValues
    if (ctx === null || mesh === null || values === null) return null
    const r = ctx.rayAt(x, y)
    const raycaster = new THREE.Raycaster(new THREE.Vector3(...r.origin), new THREE.Vector3(...r.direction).normalize())
    const hit = raycaster.intersectObject(mesh, false)[0]
    if (hit === undefined || hit.face === undefined || hit.face === null) return null
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a)
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b)
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c)
    const bary = new THREE.Vector3()
    if (THREE.Triangle.getBarycoord(hit.point, a, b, c, bary) === null) return values[hit.face.a]
    return values[hit.face.a] * bary.x + values[hit.face.b] * bary.y + values[hit.face.c] * bary.z
  }

  private hideProbe(): void {
    if (this.probeLabel !== null) this.probeLabel.style.display = 'none'
  }

  // ── Pointer ──────────────────────────────────────────────────────────────

  onClick(listener: (pick: SimPick | null, ev: PointerEvent) => void): () => void {
    this.clickListeners.add(listener)
    return () => {
      this.clickListeners.delete(listener)
    }
  }

  onHover(listener: (pick: SimPick | null) => void): () => void {
    this.hoverListeners.add(listener)
    return () => {
      this.hoverListeners.delete(listener)
    }
  }

  private canvasPoint(ev: PointerEvent): { x: number; y: number } | null {
    const ctx = this.ctx
    if (ctx === null) return null
    const rect = ctx.canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
    return { x, y }
  }

  /** The face under a canvas point. */
  pickAt(x: number, y: number): SimPick | null {
    const ctx = this.ctx
    if (ctx === null) return null
    const r = ctx.rayAt(x, y)
    const pick = ctx.wasmScene.pick_face(r.origin[0], r.origin[1], r.origin[2], r.direction[0], r.direction[1], r.direction[2])
    if (pick === undefined) return null
    try {
      return { object: pick.object(), face: pick.face(), instance: pick.instance() }
    } finally {
      pick.free()
    }
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (!this.active || ev.button !== 0) return
    // The left button is the study's: no modelling tool sees it.
    ev.stopPropagation()
    this.press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }
  }

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (!this.active || ev.button !== 0) return
    ev.stopPropagation()
    const press = this.press
    this.press = null
    if (press === null || press.id !== ev.pointerId) return
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > CLICK_SLOP) return
    const p = this.canvasPoint(ev)
    const pick = p === null ? null : this.pickAt(p.x, p.y)
    for (const l of this.clickListeners) l(pick, ev)
  }

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (!this.active) return
    this.pendingMove = this.canvasPoint(ev)
    if (this.moveFrame === 0) this.moveFrame = requestAnimationFrame(this.flushMove)
  }

  private readonly onPointerLeave = (): void => {
    this.pendingMove = null
    this.hideProbe()
    this.emitHover(null)
  }

  private readonly flushMove = (): void => {
    this.moveFrame = 0
    const p = this.pendingMove
    if (!this.active || p === null) return
    if (this.hoverListeners.size > 0) this.emitHover(this.pickAt(p.x, p.y))
    const label = this.probeLabel
    if (label === null) return
    const value = this.probeFormat === null ? null : this.probeAt(p.x, p.y)
    if (value === null || this.probeFormat === null) {
      label.style.display = 'none'
      return
    }
    label.textContent = this.probeFormat(value)
    label.style.left = `${p.x + 14}px`
    label.style.top = `${p.y + 14}px`
    label.style.display = 'block'
  }

  private emitHover(pick: SimPick | null): void {
    const key = pick === null ? null : `${pick.object}:${pick.face}`
    if (key === this.lastHover) return
    this.lastHover = key
    for (const l of this.hoverListeners) l(pick)
  }
}

/** The one layer: a page has one viewport. */
export const simLayer = new SimLayer()
