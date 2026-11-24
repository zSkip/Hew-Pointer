/**
 * An Object's faces as the simulation sees them, and the geometry a `sim.run`
 * sends.
 *
 * `Scene.object_mesh` lays its vertices out per face (each face has its own
 * copies, in face order), so the faces are the connected pieces of the index
 * buffer: no two faces share a vertex, and every triangle of one face is
 * reached from any other through shared vertices. A face the pointer picks
 * (`pick_face`, a kernel face handle) is found through `face_mesh_range`,
 * whose first vertex lies in that face's piece.
 *
 * Positions are the kernel's, in meters; the request is in millimetres.
 */

import { toBase64 } from '../host'
import type { Scene as WasmScene } from '../../wasm/loader'

export type FacesScene = Pick<WasmScene, 'object_mesh' | 'face_mesh_range' | 'pick_face_geometry'>

export interface SimFace {
  /** The face's triangles (indices into the mesh's triangle list). */
  triangles: number[]
  /** A point inside the face (the centroid of its largest triangle), meters. */
  anchor: [number, number, number]
  /** The face's outward unit normal at `anchor`. */
  normal: [number, number, number]
  /** Area in m². */
  area: number
}

export interface ObjectFaces {
  object: bigint
  /** Render mesh positions, meters, xyz per vertex (duplicated per face). */
  positions: Float32Array
  indices: Uint32Array
  /** The face each vertex belongs to. */
  faceOfVertex: Int32Array
  /** The face each triangle belongs to. */
  faceOfTriangle: Uint32Array
  faces: SimFace[]
  /** Axis-aligned bounds, meters. */
  min: [number, number, number]
  max: [number, number, number]
}

function find(parent: Int32Array, i: number): number {
  let r = i
  while (parent[r] !== r) r = parent[r]
  while (parent[i] !== r) {
    const next = parent[i]
    parent[i] = r
    i = next
  }
  return r
}

/** Group a triangle mesh into faces: the connected pieces of its index buffer. */
export function facesFromMesh(object: bigint, positions: Float32Array, indices: Uint32Array): ObjectFaces {
  const vertexCount = positions.length / 3
  const parent = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i
  const triCount = Math.floor(indices.length / 3)
  for (let t = 0; t < triCount; t++) {
    const a = find(parent, indices[3 * t])
    const b = find(parent, indices[3 * t + 1])
    const c = find(parent, indices[3 * t + 2])
    // Union to the smallest root, so a face is numbered by its first vertex.
    const r = Math.min(a, b, c)
    parent[a] = r
    parent[b] = r
    parent[c] = r
  }
  const faceOfVertex = new Int32Array(vertexCount).fill(-1)
  const faceOfRoot = new Map<number, number>()
  const faces: SimFace[] = []
  const faceOfTriangle = new Uint32Array(triCount)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[3 * i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  // Faces in vertex order: the kernel's face order.
  const roots: number[] = []
  for (let t = 0; t < triCount; t++) roots.push(find(parent, indices[3 * t]))
  const order = [...new Set(roots)].sort((x, y) => x - y)
  for (const r of order) {
    faceOfRoot.set(r, faces.length)
    faces.push({ triangles: [], anchor: [0, 0, 0], normal: [0, 0, 1], area: 0 })
  }
  // The largest triangle of each face so far: its centroid is the anchor.
  const largest = new Float64Array(faces.length).fill(-1)
  for (let t = 0; t < triCount; t++) {
    const f = faceOfRoot.get(roots[t])!
    faceOfTriangle[t] = f
    const face = faces[f]
    face.triangles.push(t)
    const ia = 3 * indices[3 * t]
    const ib = 3 * indices[3 * t + 1]
    const ic = 3 * indices[3 * t + 2]
    const ux = positions[ib] - positions[ia]
    const uy = positions[ib + 1] - positions[ia + 1]
    const uz = positions[ib + 2] - positions[ia + 2]
    const vx = positions[ic] - positions[ia]
    const vy = positions[ic + 1] - positions[ia + 1]
    const vz = positions[ic + 2] - positions[ia + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    const area = len / 2
    face.area += area
    if (len > 0 && area > largest[f]) {
      largest[f] = area
      face.anchor = [
        (positions[ia] + positions[ib] + positions[ic]) / 3,
        (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3,
        (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3,
      ]
      face.normal = [nx / len, ny / len, nz / len]
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    const f = faceOfRoot.get(find(parent, i))
    if (f !== undefined) faceOfVertex[i] = f
  }
  return { object, positions, indices, faceOfVertex, faceOfTriangle, faces, min, max }
}

/** The Object's faces, from its render mesh. Throws when the Object is gone. */
export function objectFaces(scene: FacesScene, object: bigint): ObjectFaces {
  const mesh = scene.object_mesh(object)
  try {
    return facesFromMesh(object, mesh.positions(), mesh.indices())
  } finally {
    mesh.free()
  }
}

/** The face (index into `faces`) a kernel face handle stands for, or null. */
export function faceForHandle(scene: FacesScene, of: ObjectFaces, face: bigint): number | null {
  const range = scene.face_mesh_range(of.object, face)
  if (range === undefined || range.length < 2 || range[0] >= of.faceOfVertex.length) return null
  const f = of.faceOfVertex[range[0]]
  return f < 0 ? null : f
}

/** The kernel face handle of each face, as a decimal string: a short ray at
 *  the face's anchor, from just outside it. A face the ray does not find
 *  (another Object's face lying on it) is named by its index instead; the
 *  host reads the names only as labels. */
export function faceHandles(scene: FacesScene, of: ObjectFaces): string[] {
  const eps = 1e-5
  return of.faces.map((face, i) => {
    const [x, y, z] = face.anchor
    const [nx, ny, nz] = face.normal
    const pick = scene.pick_face_geometry(x + nx * eps, y + ny * eps, z + nz * eps, -nx, -ny, -nz)
    if (pick === undefined) return String(i)
    try {
      if (pick.object() !== of.object) return String(i)
      const handle = pick.face()
      return faceForHandle(scene, of, handle) === i ? handle.toString() : String(i)
    } finally {
      pick.free()
    }
  })
}

/** The welded surface a `sim.run` sends: coincident vertices merged so the
 *  surface is closed, millimetres, degenerate triangles dropped. */
export interface WeldedSurface {
  positions: Float32Array
  indices: Uint32Array
  faceIndex: Uint32Array
}

/** Points closer than this (meters) are one point. */
const WELD = 1e-7

export function weldSurface(of: ObjectFaces): WeldedSurface {
  const keyOf = (i: number) =>
    `${Math.round(of.positions[3 * i] / WELD)},${Math.round(of.positions[3 * i + 1] / WELD)},${Math.round(of.positions[3 * i + 2] / WELD)}`
  const remap = new Uint32Array(of.positions.length / 3)
  const byKey = new Map<string, number>()
  const out: number[] = []
  for (let i = 0; i < remap.length; i++) {
    const key = keyOf(i)
    let j = byKey.get(key)
    if (j === undefined) {
      j = out.length / 3
      byKey.set(key, j)
      out.push(of.positions[3 * i] * 1000, of.positions[3 * i + 1] * 1000, of.positions[3 * i + 2] * 1000)
    }
    remap[i] = j
  }
  const indices: number[] = []
  const faceIndex: number[] = []
  for (let t = 0; t < of.faceOfTriangle.length; t++) {
    const a = remap[of.indices[3 * t]]
    const b = remap[of.indices[3 * t + 1]]
    const c = remap[of.indices[3 * t + 2]]
    if (a === b || b === c || a === c) continue
    indices.push(a, b, c)
    faceIndex.push(of.faceOfTriangle[t])
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(indices), faceIndex: Uint32Array.from(faceIndex) }
}

function bytesOf(a: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}

/** The `geometry` of a `sim.run` for one Object (docs/HLSD/hew-tab.md). */
export interface SimGeometry {
  objects: { id: string; faces: string[]; positions: string; indices: string; faceIndex: string }[]
}

export function simGeometry(objectId: string, faceNames: string[], surface: WeldedSurface): SimGeometry {
  return {
    objects: [
      {
        id: objectId,
        faces: faceNames,
        positions: toBase64(bytesOf(surface.positions)),
        indices: toBase64(bytesOf(surface.indices)),
        faceIndex: toBase64(bytesOf(surface.faceIndex)),
      },
    ],
  }
}

/** A cheap fingerprint of the Object's shape, to tell when it changed. */
export function shapeSignature(of: ObjectFaces): string {
  let h = 0x811c9dc5
  const mix = (v: number) => {
    h ^= v
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const p = new Uint32Array(of.positions.buffer, of.positions.byteOffset, of.positions.length)
  for (let i = 0; i < p.length; i++) mix(p[i])
  for (let i = 0; i < of.indices.length; i++) mix(of.indices[i])
  return `${of.positions.length}:${of.indices.length}:${h.toString(16)}`
}
