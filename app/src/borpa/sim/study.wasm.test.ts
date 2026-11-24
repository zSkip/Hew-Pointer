/**
 * Simulation studies through the REAL compiled wasm module: an Object's faces
 * and the welded surface a `sim.run` sends, studies stored in `borpa.sim`
 * dictionaries one undo step per change, picked faces that follow their face
 * through an edit and a save, and faces an edit removed reported as lost.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import init, { Scene } from '../../wasm/pkg/wasm_api.js'
import type { Scene as WasmScene } from '../../wasm/loader'
import { faceForHandle, faceHandles, objectFaces, shapeSignature, simGeometry, weldSurface, type ObjectFaces } from './objectFaces'
import { placeholderMaterial } from './placeholderMaterials'
import { withApi } from '../buildMaterial'
import { addItem, readStudy, removeItem, requestStudy, studyProblem, toggleFace, writeStudy, type ResolvedStudy } from './study'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

beforeAll(async () => {
  const wasmBytes = await readFile(resolve(__dirname, '../../wasm/pkg/wasm_api_bg.wasm'))
  await init({ module_or_path: wasmBytes })
})

let scene: WasmScene

beforeEach(() => {
  scene = new Scene() as unknown as WasmScene
})

/** The cantilever: a 100 x 10 x 10 mm bar along x, on the ground. */
function makeBar(s: WasmScene): bigint {
  const sketch = s.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
  const c: Array<[number, number]> = [[0, 0], [0.1, 0], [0.1, 0.01], [0, 0.01]]
  for (let i = 0; i < 4; i++) {
    const a = c[i]
    const b = c[(i + 1) % 4]
    s.sketch_add_segment(sketch, a[0], a[1], 0, b[0], b[1], 0)
  }
  const regions = Array.from(s.sketch_regions(sketch))
  return s.extrude_region(sketch, regions[0], 0.01)
}

/** The kernel face handle of the bar's end at x = `x`, through a pick. */
function endFace(s: WasmScene, object: bigint, x: number): bigint {
  const dir = x <= 0 ? 1 : -1
  const pick = s.pick_face_geometry(x - dir * 0.05, 0.005, 0.005, dir, 0, 0)
  expect(pick).toBeDefined()
  try {
    expect(pick!.object()).toBe(object)
    return pick!.face()
  } finally {
    pick!.free()
  }
}

/** The face (index) of `of` whose outward normal is `n`. */
function faceWithNormal(of: ObjectFaces, n: [number, number, number]): number {
  const i = of.faces.findIndex((f) => f.normal.every((v, k) => Math.abs(v - n[k]) < 1e-6))
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}

function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

describe('an Object as faces', () => {
  it('groups the bar into its six faces with outward normals and anchors on them', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    expect(of.faces).toHaveLength(6)
    expect(of.faces.every((f) => f.triangles.length >= 2)).toBe(true)
    const normals = of.faces.map((f) => f.normal.map((v) => Math.round(v)).join(','))
    expect(new Set(normals)).toEqual(new Set(['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']))
    const end = of.faces[faceWithNormal(of, [-1, 0, 0])]
    expect(end.anchor[0]).toBeCloseTo(0, 6)
    expect(end.area).toBeCloseTo(1e-4, 9)
    expect(of.max[0] - of.min[0]).toBeCloseTo(0.1, 6)
  })

  it('finds the face a pick names', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    expect(faceForHandle(scene, of, endFace(scene, bar, 0.1))).toBe(faceWithNormal(of, [1, 0, 0]))
    expect(faceForHandle(scene, of, endFace(scene, bar, 0))).toBe(faceWithNormal(of, [-1, 0, 0]))
  })

  it('names every face by its kernel handle', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    const names = faceHandles(scene, of)
    expect(names).toHaveLength(6)
    expect(names.every((n) => /^\d+$/.test(n))).toBe(true)
    expect(new Set(names).size).toBe(6)
    expect(names[faceWithNormal(of, [1, 0, 0])]).toBe(endFace(scene, bar, 0.1).toString())
  })

  it('welds the surface closed, in millimetres', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    const w = weldSurface(of)
    expect(w.positions.length / 3).toBe(8)
    expect(w.indices.length / 3).toBe(12)
    expect(w.faceIndex).toHaveLength(12)
    // Closed: every edge is shared by exactly two triangles, once each way.
    const edges = new Map<string, number>()
    for (let t = 0; t < 12; t++) {
      for (let k = 0; k < 3; k++) {
        const a = w.indices[3 * t + k]
        const b = w.indices[3 * t + ((k + 1) % 3)]
        edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1)
      }
    }
    for (const [key, n] of edges) {
      expect(n).toBe(1)
      const [a, b] = key.split('>')
      expect(edges.get(`${b}>${a}`)).toBe(1)
    }
    const xs = [...w.positions].filter((_, i) => i % 3 === 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 4)
  })

  it('encodes the geometry as the host reads it', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    const w = weldSurface(of)
    const g = simGeometry('obj-1', faceHandles(scene, of), w)
    const o = g.objects[0]
    expect(o.id).toBe('obj-1')
    expect(o.faces).toHaveLength(6)
    const positions = new Float32Array(decode(o.positions).buffer)
    const indices = new Uint32Array(decode(o.indices).buffer)
    const faceIndex = new Uint32Array(decode(o.faceIndex).buffer)
    expect([...positions]).toEqual([...w.positions])
    expect([...indices]).toEqual([...w.indices])
    expect([...faceIndex]).toEqual([...w.faceIndex])
    expect(Math.max(...faceIndex)).toBeLessThan(o.faces.length)
  })

  it('changes its signature when the shape changes', () => {
    const bar = makeBar(scene)
    const before = shapeSignature(objectFaces(scene, bar))
    expect(shapeSignature(objectFaces(scene, bar))).toBe(before)
    scene.push_pull(bar, endFace(scene, bar, 0.1), 0.01).free()
    expect(shapeSignature(objectFaces(scene, bar))).not.toBe(before)
  })
})

describe('a study in the document', () => {
  /** The cantilever study: fixed at x = 0, 10 N down at x = 100 mm. */
  function cantilever(s: WasmScene, bar: bigint): { of: ObjectFaces; study: ResolvedStudy } {
    let of = objectFaces(s, bar)
    const fixture = addItem(s, bar, null, 'fixture', 'Add fixture')
    let study = readStudy(s, of)!
    toggleFace(s, of, study, fixture, faceWithNormal(of, [-1, 0, 0]), 'Change fixed faces')
    study = readStudy(s, of)!
    const force = addItem(s, bar, study.stored, 'force', 'Add force')
    study = readStudy(s, of)!
    toggleFace(s, of, study, force, faceWithNormal(of, [1, 0, 0]), 'Change loaded faces')
    study = readStudy(s, of)!
    of = objectFaces(s, bar)
    return { of, study: readStudy(s, of)! }
  }

  it('has none until one is made', () => {
    const bar = makeBar(scene)
    expect(readStudy(scene, objectFaces(scene, bar))).toBeNull()
  })

  it('stores fixtures and forces on the Object and its faces, one undo step per change', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    const depth = scene.undo_depth()
    const key = addItem(scene, bar, null, 'fixture', 'Add fixture')
    expect(scene.undo_depth()).toBe(depth + 1)
    let study = readStudy(scene, of)!
    expect(study.fixtures).toEqual([{ key, faces: [], lost: 0 }])

    const end = faceWithNormal(of, [-1, 0, 0])
    toggleFace(scene, of, study, key, end, 'Change fixed faces')
    expect(scene.undo_depth()).toBe(depth + 2)
    study = readStudy(scene, of)!
    expect(study.fixtures[0].faces).toEqual([end])

    // Undo takes the face out again, mark and list together.
    scene.scene_undo().free()
    study = readStudy(scene, of)!
    expect(study.fixtures[0]).toEqual({ key, faces: [], lost: 0 })
    expect(study.facePicks.size).toBe(0)
    scene.scene_redo().free()
    expect(readStudy(scene, of)!.fixtures[0].faces).toEqual([end])

    // A second click on the face takes it out.
    study = readStudy(scene, of)!
    toggleFace(scene, of, study, key, end, 'Change fixed faces')
    study = readStudy(scene, of)!
    expect(study.fixtures[0].faces).toEqual([])
    expect(study.stored.fixtures[0].picks).toEqual([])
  })

  it('labels each step', () => {
    const bar = makeBar(scene)
    addItem(scene, bar, null, 'force', 'Add force')
    const entries = JSON.parse(scene.history_entries_json()) as { undo: { label: string }[] }
    expect(entries.undo[entries.undo.length - 1].label).toBe('Add force')
  })

  it('builds the sim.run study the host parses', () => {
    const bar = makeBar(scene)
    const { of, study } = cantilever(scene, bar)
    const material = { ...placeholderMaterial('Generic PLA', 'PLA'), E: 2000, nu: 0.3 }
    expect(studyProblem(study, material)).toBeNull()
    expect(requestStudy('obj-1', study, material)).toEqual({
      version: 1,
      kind: 'static',
      object: 'obj-1',
      material: { name: 'Generic PLA', E: 2000, nu: 0.3, density: 1.24e-9 },
      fixtures: [{ faces: [faceWithNormal(of, [-1, 0, 0])] }],
      loads: [{ type: 'force', faces: [faceWithNormal(of, [1, 0, 0])], vector: [0, 0, -10] }],
      mesh: { size: null, refine: [] },
    })
  })

  it('says what is missing before it can run', () => {
    const bar = makeBar(scene)
    const of = objectFaces(scene, bar)
    const pla = placeholderMaterial('PLA', 'PLA')
    addItem(scene, bar, null, 'fixture', 'Add fixture')
    let study = readStudy(scene, of)!
    expect(studyProblem(study, pla)).toBe('empty-fixture')
    toggleFace(scene, of, study, study.fixtures[0].key, 0, 'x')
    study = readStudy(scene, of)!
    expect(studyProblem(study, pla)).toBe('no-force')
    expect(studyProblem(study, { ...pla, nu: 0.5 })).toBe('bad-material')
    const next = structuredClone(study.stored)
    next.loads.push({ key: 'l9', vector: [0, 0, 0], picks: [] })
    writeStudy(scene, bar, next, 'x')
    study = readStudy(scene, of)!
    expect(studyProblem(study, pla)).toBe('empty-force')
  })

  it('keeps its faces through a save and reopen', () => {
    const bar = makeBar(scene)
    const { of, study } = cantilever(scene, bar)
    const bytes = scene.save()
    const reopened = new Scene() as unknown as WasmScene
    reopened.load(bytes)
    const [object] = Array.from(reopened.object_ids())
    const of2 = objectFaces(reopened, object)
    const study2 = readStudy(reopened, of2)!
    const axis = (n: number[]) => n.map((v) => Math.round(v) + 0)
    expect(study2.fixtures.map((f) => f.faces.map((i) => axis(of2.faces[i].normal)))).toEqual(
      study.fixtures.map((f) => f.faces.map((i) => axis(of.faces[i].normal))),
    )
    expect(study2.fixtures[0].faces.map((i) => axis(of2.faces[i].normal))).toEqual([[-1, 0, 0]])
    expect(study2.loads[0].faces.map((i) => axis(of2.faces[i].normal))).toEqual([[1, 0, 0]])
    expect(study2.loads[0].vector).toEqual([0, 0, -10])
  })

  it('follows a face that is pulled', () => {
    const bar = makeBar(scene)
    cantilever(scene, bar)
    scene.push_pull(bar, endFace(scene, bar, 0.1), 0.02).free()
    const of = objectFaces(scene, bar)
    const study = readStudy(scene, of)!
    expect(study.loads[0].lost).toBe(0)
    expect(study.loads[0].faces).toHaveLength(1)
    expect(of.faces[study.loads[0].faces[0]].anchor[0]).toBeCloseTo(0.12, 6)
  })

  it('reports a face an edit removed as lost', () => {
    const bar = makeBar(scene)
    cantilever(scene, bar)
    // Cut the loaded end off: the new end face is the cutter's, unmarked.
    const sketch = scene.begin_sketch_on_plane(0, 0, -0.01, 0, 0, 1)
    const c: Array<[number, number]> = [[0.09, -0.01], [0.2, -0.01], [0.2, 0.02], [0.09, 0.02]]
    for (let i = 0; i < 4; i++) scene.sketch_add_segment(sketch, c[i][0], c[i][1], -0.01, c[(i + 1) % 4][0], c[(i + 1) % 4][1], -0.01)
    const cutter = scene.extrude_region(sketch, Array.from(scene.sketch_regions(sketch))[0], 0.03)
    const [a, b] = scene.object_public_ids(BigUint64Array.from([bar, cutter]))
    withApi(scene, (api) => api.send('hew.solid.subtract', { a, b }))
    const objects = Array.from(scene.object_ids())
    expect(objects).toHaveLength(1)
    const study = readStudy(scene, objectFaces(scene, objects[0]))!
    expect(study.loads[0]).toMatchObject({ faces: [], lost: 1 })
    expect(study.fixtures[0]).toMatchObject({ lost: 0 })
    expect(study.fixtures[0].faces).toHaveLength(1)
  })

  it('removes a force with its marks', () => {
    const bar = makeBar(scene)
    const { of, study } = cantilever(scene, bar)
    removeItem(scene, of, study, study.loads[0].key, 'Remove force')
    const after = readStudy(scene, of)!
    expect(after.loads).toEqual([])
    expect([...after.facePicks.keys()]).toEqual(study.fixtures[0].faces)
  })
})
