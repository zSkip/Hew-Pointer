/**
 * Build materials through the REAL compiled wasm module: new geometry takes
 * the selected filament in the same undo step, the filament's material is
 * linked to its preset by a `borpa.filament` dictionary, imports and older
 * documents end with one filament per Object, and the selection can be given
 * another filament.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import init, { Scene } from '../wasm/pkg/wasm_api.js'
import type { Scene as WasmScene } from '../wasm/loader'
import { assignFilament, colourChannels, readFilamentLinks } from './buildMaterial'
import { allObjectIds, flattenDocument, withBuildFilament } from './filamentScene'
import { GENERIC_FILAMENTS, resetFilamentsForTest, selectFilament, type Filament } from './filaments'
import { inHistoryBracket } from '../tools/transformSelection'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

beforeAll(async () => {
  const wasmBytes = await readFile(resolve(__dirname, '../wasm/pkg/wasm_api_bg.wasm'))
  await init({ module_or_path: wasmBytes })
})

const NO_MATERIAL = 0xffff_ffff_ffff_ffffn
const byName = (name: string): Filament => GENERIC_FILAMENTS.find((f) => f.name === name)!

let scene: WasmScene

beforeEach(() => {
  resetFilamentsForTest(GENERIC_FILAMENTS, 'Generic PETG')
  scene = withBuildFilament(new Scene() as unknown as WasmScene)
})

afterEach(() => resetFilamentsForTest(GENERIC_FILAMENTS))

/** A [x0,x0+1]x[0,1] box on the ground, 1 tall, extruded from a sketch. */
function makeBox(s: WasmScene, x0 = 0): bigint {
  const sketch = s.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
  const c: Array<[number, number]> = [[x0, 0], [x0 + 1, 0], [x0 + 1, 1], [x0, 1]]
  for (let i = 0; i < 4; i++) {
    const a = c[i]
    const b = c[(i + 1) % 4]
    s.sketch_add_segment(sketch, a[0], a[1], 0, b[0], b[1], 0)
  }
  const regions = Array.from(s.sketch_regions(sketch))
  return s.extrude_region(sketch, regions[0], 1)
}

/** A tetrahedron, in millimetres. */
const TETRA_STL = `solid t
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 10 0
  vertex 10 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 0 10
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 0 0
  vertex 0 0 10
  vertex 0 10 0
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 10 0 0
  vertex 0 10 0
  vertex 0 0 10
 endloop
endfacet
endsolid t
`

/** The Object's materials by name: its base and any per-face paint. */
function materialNames(s: WasmScene, object: bigint): string[] {
  return Array.from(s.object_materials(object)).map((m) => s.material_info(m)?.name() ?? '?')
}

describe('new geometry is built in the selected filament', () => {
  it('gives an extruded Object the selected filament, linked to its preset, in one undo step', () => {
    const depth = scene.undo_depth()
    const box = makeBox(scene)
    expect(materialNames(scene, box)).toEqual(['Generic PETG'])
    const [material] = Array.from(scene.object_materials(box))
    const info = scene.material_info(material)!
    expect([info.r(), info.g(), info.b()]).toEqual(colourChannels(byName('Generic PETG').colour).slice(0, 3))
    expect(readFilamentLinks(scene).get(material)).toEqual({ preset: 'Generic PETG', type: 'PETG', vendor: 'Generic' })
    // The sketch, the extrusion and the filament: drawing the square took
    // its own steps, the extrusion with its filament one more.
    expect(scene.undo_depth()).toBeGreaterThan(depth)
    const before = scene.undo_depth()
    scene.scene_undo().free()
    expect(scene.undo_depth()).toBe(before - 1)
    expect(Array.from(scene.object_ids())).not.toContain(box)
  })

  it('labels the step as the operation, not as the filament', () => {
    makeBox(scene)
    const entries = JSON.parse(scene.history_entries_json()) as { undo: { label: string }[] }
    expect(entries.undo[entries.undo.length - 1].label).not.toMatch(/filament/i)
  })

  it('builds the next Object in a newly selected filament and reuses each filament material', () => {
    const a = makeBox(scene, 0)
    selectFilament('Generic PLA')
    const b = makeBox(scene, 3)
    selectFilament('Generic PETG')
    const c = makeBox(scene, 6)
    expect(materialNames(scene, a)).toEqual(['Generic PETG'])
    expect(materialNames(scene, b)).toEqual(['Generic PLA'])
    expect(scene.object_materials(c)).toEqual(scene.object_materials(a))
    expect(scene.material_ids().length).toBe(2)
  })

  it('keeps the filament across undo and redo, and reuses the material after an undo', () => {
    const box = makeBox(scene)
    const [material] = Array.from(scene.object_materials(box))
    scene.scene_undo().free()
    scene.scene_redo().free()
    expect(materialNames(scene, box)).toEqual(['Generic PETG'])
    expect(readFilamentLinks(scene).get(material)?.preset).toBe('Generic PETG')
    // Undone: the link goes with the step, the palette entry stays and is
    // linked again by the next Object rather than duplicated.
    scene.scene_undo().free()
    const again = makeBox(scene)
    expect(Array.from(scene.object_materials(again))).toEqual([material])
    expect(scene.material_ids().length).toBe(1)
  })

  it('leaves no step behind when the operation is refused, and passes its error on unchanged', () => {
    const sketch = scene.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
    const raw = new Scene() as unknown as WasmScene
    const rawSketch = raw.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
    const refusal = (s: WasmScene, sk: bigint): string => {
      try {
        s.extrude_region(sk, 12345n, 1)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
      return 'no error'
    }
    const depth = scene.undo_depth()
    const entries = scene.history_entries_json()
    const expected = refusal(raw, rawSketch)
    expect(expected).not.toBe('no error')
    expect(refusal(scene, sketch)).toBe(expected)
    expect(scene.undo_depth()).toBe(depth)
    expect(scene.history_entries_json()).toBe(entries)
    expect(scene.material_ids().length).toBe(0)
    // The bracket was closed: the next Object is its own single step.
    makeBox(scene)
    expect(scene.undo_depth()).toBeGreaterThan(depth)
  })

  it('adds no step for a bracket that changed nothing', () => {
    makeBox(scene)
    const depth = scene.undo_depth()
    const entries = scene.history_entries_json()
    inHistoryBracket(scene, 'Nothing', () => undefined)
    expect(scene.undo_depth()).toBe(depth)
    expect(scene.history_entries_json()).toBe(entries)
  })

  it('leaves new geometry without a filament when none is selected', () => {
    resetFilamentsForTest([], null)
    const box = makeBox(scene)
    expect(materialNames(scene, box)).toEqual([])
  })
})

describe('one filament per Object', () => {
  it('gives an older document\'s Objects the selected filament and clears their paint, in one undo step', () => {
    const raw = new Scene() as unknown as WasmScene
    const box = makeBox(raw)
    const red = raw.add_material('Red', 255, 0, 0, 255)
    const blue = raw.add_material('Blue', 0, 0, 255, 255)
    raw.set_object_material(box, red)
    // Paint the top face blue.
    const pick = raw.pick_face(0.5, 0.5, 5, 0, 0, -1)!
    raw.paint_face(box, pick.face(), blue)
    expect(materialNames(raw, box).sort()).toEqual(['Blue', 'Red'])
    const depth = raw.undo_depth()
    flattenDocument(raw)
    expect(materialNames(raw, box)).toEqual(['Generic PETG'])
    expect(raw.undo_depth()).toBe(depth + 1)
    // Already one filament: nothing more to do.
    flattenDocument(raw)
    expect(raw.undo_depth()).toBe(depth + 1)
  })

  it('gives every imported Object the selected filament', () => {
    selectFilament('Generic PLA')
    scene.import_stl(new TextEncoder().encode(TETRA_STL), 0.001, 'tetra')
    const objects = [...allObjectIds(scene)]
    expect(objects.length).toBe(1)
    expect(materialNames(scene, objects[0])).toEqual(['Generic PLA'])
  })

  it('makes an import and its filament one undo step, which redo restores whole', () => {
    selectFilament('Generic ABS')
    const depth = scene.undo_depth()
    scene.import_stl(new TextEncoder().encode(TETRA_STL), 0.001, 'tetra')
    expect(scene.undo_depth()).toBe(depth + 1)
    const [object] = [...allObjectIds(scene)]
    const [material] = Array.from(scene.object_materials(object))
    scene.scene_undo().free()
    expect(allObjectIds(scene).size).toBe(0)
    scene.scene_redo().free()
    expect(materialNames(scene, object)).toEqual(['Generic ABS'])
    expect(readFilamentLinks(scene).get(material)?.preset).toBe('Generic ABS')
  })

  it('gives the selected Objects another filament in one undo step', () => {
    const a = makeBox(scene, 0)
    const b = makeBox(scene, 3)
    const depth = scene.undo_depth()
    const result = assignFilament(scene, byName('Generic ABS'), [a, b], 'all', 'Assign filament')
    expect(result.assigned).toEqual([a, b])
    expect(materialNames(scene, a)).toEqual(['Generic ABS'])
    expect(materialNames(scene, b)).toEqual(['Generic ABS'])
    expect(scene.undo_depth()).toBe(depth + 1)
    scene.scene_undo().free()
    expect(materialNames(scene, a)).toEqual(['Generic PETG'])
    expect(scene.object_materials(a)).not.toContain(NO_MATERIAL)
  })
})
