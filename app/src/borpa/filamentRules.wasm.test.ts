/**
 * The different-filament rules through the REAL compiled wasm module: Push/Pull
 * pulls a new Object out of a face of another filament and cuts into it,
 * decided by direction; operations that would add material to an Object of
 * another filament are refused; a union across filaments is refused.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import init, { Scene } from '../wasm/pkg/wasm_api.js'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import { PushPullTool } from '../tools/PushPullTool'
import { PREVIEW_EXTRUDE_NEW_FALLBACK } from '../tools/previewTint'
import type { Snap } from '../tools/types'
import { friendlyErrorText, kernelErrorMessage, parseKernelErrorCode } from '../kernelErrors'
import { getLengthUnit, setLengthUnit, type LengthFormat } from '../settings/units'
import { flattenDocument, withBuildFilament } from './filamentScene'
import { FILAMENT_REFUSAL_CODE } from './filamentRules'
import { GENERIC_FILAMENTS, resetFilamentsForTest, selectFilament } from './filaments'
import { differsFromSelected, filamentDifference } from './objectFilament'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

beforeAll(async () => {
  const wasmBytes = await readFile(resolve(__dirname, '../wasm/pkg/wasm_api_bg.wasm'))
  await init({ module_or_path: wasmBytes })
})

const PETG = 'Generic PETG'
const PLA = 'Generic PLA'

let scene: WasmScene
let unit: LengthFormat

beforeEach(() => {
  unit = getLengthUnit()
  setLengthUnit('m')
  resetFilamentsForTest(GENERIC_FILAMENTS, PETG)
  scene = withBuildFilament(new Scene() as unknown as WasmScene)
})

afterEach(() => {
  setLengthUnit(unit)
  resetFilamentsForTest(GENERIC_FILAMENTS)
})

/** A [x0,x0+w]x[y0,y0+w] box on the ground, `h` tall, in the selected filament. */
function makeBox(s: WasmScene, x0 = 0, y0 = 0, w = 1, h = 1): bigint {
  const sketch = s.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
  const c: Array<[number, number]> = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + w], [x0, y0 + w]]
  for (let i = 0; i < 4; i++) {
    const a = c[i]
    const b = c[(i + 1) % 4]
    s.sketch_add_segment(sketch, a[0], a[1], 0, b[0], b[1], 0)
  }
  return s.extrude_region(sketch, Array.from(s.sketch_regions(sketch))[0], h)
}

function topFace(s: WasmScene, x = 0.5, y = 0.5): bigint {
  const pick = s.pick_face(x, y, 10, 0, 0, -1)!
  try {
    return pick.face()
  } finally {
    pick.free()
  }
}

/** A rectangle drawn on the box's top face (z = 1), as the Rectangle tool draws it. */
function drawOnTop(s: WasmScene, box: bigint, x0 = 0.25, x1 = 0.75): void {
  const d = s.draft_begin_face(box, topFace(s), 'Rectangle')
  const loop: Array<[number, number]> = [[x0, x0], [x1, x0], [x1, x1], [x0, x1]]
  for (let i = 0; i < 4; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % 4]
    s.draft_add_segment(d, a[0], a[1], 1, b[0], b[1], 1).free()
  }
  s.draft_end(d)
}

const objects = (s: WasmScene): bigint[] => Array.from(s.object_ids()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The Object's materials by name: its base and any per-face paint. */
const materialNames = (s: WasmScene, o: bigint): string[] => Array.from(s.object_materials(o)).map((m) => s.material_info(m)?.name() ?? '?')

function measure(s: WasmScene, o: bigint): { volume: number; bbox: { min: number[]; max: number[] } } {
  return JSON.parse(s.measure_json(0, o)) as { volume: number; bbox: { min: number[]; max: number[] } }
}

/** Whether a material named `name` is used anywhere. */
const inUse = (s: WasmScene, name: string): boolean =>
  Array.from(s.material_ids()).some((m) => s.material_info(m)?.name() === name && s.material_usage(m) > 0)

const down = (x: number, y: number): Ray => ({ origin: [x, y, 10], direction: [0, 0, -1] })
const on = (x: number, y: number, z: number): Snap => ({ x, y, z, kind: 'face' })
const key = (k: string): KeyboardEvent => ({ key: k }) as KeyboardEvent

function harness(s: WasmScene) {
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const preview = new THREE.Group()
  const tool = new PushPullTool(s, preview, onCommit, onToast)
  return { tool, onCommit, onToast, preview }
}

/** The colours the ghost is drawn in. */
function ghostColours(preview: THREE.Group): number[] {
  const out: number[] = []
  preview.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material & { color?: THREE.Color }
    if (m !== undefined && !Array.isArray(m) && m.color !== undefined) out.push(m.color.getHex())
  })
  return out
}

/** Hover and click the face at (x, y, z), then drag to height `to`. */
function startDrag(tool: PushPullTool, x: number, y: number, z: number, to: number): void {
  tool.onPointerMove(on(x, y, z), down(x, y))
  tool.onPointerDown(on(x, y, z), down(x, y))
  tool.onPointerMove(on(x, y, to), { origin: [x + 5, y, to], direction: [-1, 0, 0] })
}

/** A whole Push/Pull gesture from the face at height `z` to height `to`. */
function pushPull(tool: PushPullTool, x: number, y: number, z: number, to: number): void {
  startDrag(tool, x, y, z, to)
  tool.onPointerDown(on(x, y, to), { origin: [x + 5, y, to], direction: [-1, 0, 0] })
}

function type(tool: PushPullTool, text: string): void {
  for (const ch of text) tool.onKey(key(ch))
  tool.onKey(key('Enter'))
}

/** The goal's setup: a PETG box with a rectangle drawn on its top face, PLA selected. */
function petgBoxWithRectangle(): bigint {
  const box = makeBox(scene)
  drawOnTop(scene, box)
  selectFilament(PLA)
  return box
}

describe('Push/Pull on a face of another filament', () => {
  it('pulls a rectangle on a PETG face up into a separate PLA Object standing on it, one undo step', () => {
    const box = petgBoxWithRectangle()
    const before = objects(scene)
    const { tool, onToast } = harness(scene)
    pushPull(tool, 0.5, 0.5, 1, 1.5)

    expect(onToast).not.toHaveBeenCalled()
    const after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    const fresh = after.find((o) => !before.includes(o))!
    expect(materialNames(scene, box)).toEqual([PETG])
    expect(materialNames(scene, fresh)).toEqual([PLA])
    expect(measure(scene, box).volume).toBeCloseTo(1, 9)
    const { bbox } = measure(scene, fresh)
    expect(bbox.min[2]).toBeCloseTo(1, 9)
    expect(bbox.max[2]).toBeCloseTo(1.5, 9)
    expect(bbox.min[0]).toBeCloseTo(0.25, 9)
    expect(bbox.max[0]).toBeCloseTo(0.75, 9)

    // One undo removes the PLA Object and nothing else.
    scene.scene_undo().free()
    expect(objects(scene)).toEqual(before)
    expect(materialNames(scene, box)).toEqual([PETG])
    expect(measure(scene, box).volume).toBeCloseTo(1, 9)
    // Redo brings it back with its filament.
    scene.scene_redo().free()
    expect(objects(scene)).toEqual(after)
    expect(materialNames(scene, fresh)).toEqual([PLA])
  })

  it('pushes the same rectangle down into a pocket in the PETG Object, making nothing', () => {
    const box = petgBoxWithRectangle()
    const before = objects(scene)
    const { tool, onToast } = harness(scene)
    pushPull(tool, 0.5, 0.5, 1, 0.5)

    expect(onToast).not.toHaveBeenCalled()
    expect(objects(scene)).toEqual(before)
    expect(materialNames(scene, box)).toEqual([PETG])
    expect(measure(scene, box).volume).toBeCloseTo(1 - 0.5 * 0.5 * 0.5, 9)
    expect(inUse(scene, PLA)).toBe(false)
  })

  it('decides live as the drag crosses the face: blue and "new object" out of it, push colours into it', () => {
    petgBoxWithRectangle()
    const { tool, preview } = harness(scene)
    // Hovering says what each direction does.
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).toContain(`This face is ${PETG}`)
    expect(tool.statusHint()).toContain(`new ${PLA} object`)

    startDrag(tool, 0.5, 0.5, 1, 1.4)
    expect(tool.statusHint()).toBe(`Pulls out a new ${PLA} object: this face is ${PETG}. Click to commit — or type an exact distance.`)
    expect(ghostColours(preview)).toContain(PREVIEW_EXTRUDE_NEW_FALLBACK)

    tool.onPointerMove(on(0.5, 0.5, 0.6), { origin: [5.5, 0.5, 0.6], direction: [-1, 0, 0] })
    expect(tool.statusHint()).toBe('Move to extrude, click to commit — or type an exact distance. Tap Ctrl to extrude a new object instead.')
    expect(ghostColours(preview)).not.toContain(PREVIEW_EXTRUDE_NEW_FALLBACK)
  })

  it('cannot be switched off with Ctrl/Cmd: a pull out of a PETG face is a new PLA Object either way', () => {
    const box = petgBoxWithRectangle()
    const before = objects(scene)
    const { tool } = harness(scene)
    tool.toggleExtrudeAsNew()
    tool.toggleExtrudeAsNew()
    pushPull(tool, 0.5, 0.5, 1, 1.5)
    expect(objects(scene)).toHaveLength(before.length + 1)
    expect(measure(scene, box).volume).toBeCloseTo(1, 9)
  })

  it('follows the sign of a typed distance, and of a distance retyped after the commit', () => {
    const box = petgBoxWithRectangle()
    const before = objects(scene)
    const { tool, onToast } = harness(scene)

    // Click the face, type 0.3: out of it, a new PLA Object.
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    tool.onPointerDown(on(0.5, 0.5, 1), down(0.5, 0.5))
    type(tool, '0.3')
    let after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    const fresh = after.find((o) => !before.includes(o))!
    expect(materialNames(scene, fresh)).toEqual([PLA])
    expect(measure(scene, fresh).bbox.max[2]).toBeCloseTo(1.3, 9)

    // Retype -0.2: the pull is redone as a push, a pocket and no new Object.
    type(tool, '-0.2')
    expect(onToast).not.toHaveBeenCalled()
    expect(objects(scene)).toEqual(before)
    expect(measure(scene, box).volume).toBeCloseTo(1 - 0.25 * 0.2, 9)
    expect(inUse(scene, PLA)).toBe(false)

    // Retype 0.4 (a positive value keeps the committed direction: in).
    type(tool, '0.4')
    expect(objects(scene)).toEqual(before)
    expect(measure(scene, box).volume).toBeCloseTo(1 - 0.25 * 0.4, 9)

    // A fresh typed -0.1 on the other side: a cut, nothing new.
    tool.onPointerMove(on(0.1, 0.1, 1), down(0.1, 0.1))
    tool.onPointerDown(on(0.1, 0.1, 1), down(0.1, 0.1))
    type(tool, '-0.1')
    after = objects(scene)
    expect(after).toEqual(before)
  })

  it('double-click repeats the last distance under the same rule', () => {
    const box = petgBoxWithRectangle()
    const before = objects(scene)
    const { tool } = harness(scene)
    pushPull(tool, 0.5, 0.5, 1, 1.25)
    expect(objects(scene)).toHaveLength(before.length + 1)
    // Double-click the box's top outside the rectangle: a second new Object.
    tool.onPointerMove(on(0.1, 0.1, 1), down(0.1, 0.1))
    tool.onPointerDown(on(0.1, 0.1, 1), down(0.1, 0.1))
    expect(tool.onDoubleClick(null, down(0.1, 0.1))).toBe(true)
    expect(objects(scene)).toHaveLength(before.length + 2)
    expect(measure(scene, box).volume).toBeCloseTo(1, 9)
  })
})

/** A 1 m square sheet at z = 0, facing up. */
const SQUARE_STL = `solid sq
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 1 1 0
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 1 0
  vertex 0 1 0
 endloop
endfacet
endsolid sq
`

describe('Push/Pull on a flat sheet of another filament', () => {
  it('pulls a new PLA Object off a PETG sheet in either direction, the sheet left as it was; thickening it directly is refused', () => {
    scene.import_stl(new TextEncoder().encode(SQUARE_STL), 1, 'sheet')
    const [sheet] = objects(scene)
    expect(materialNames(scene, sheet)).toEqual([PETG])
    selectFilament(PLA)
    const before = objects(scene)
    const { tool, onToast, preview } = harness(scene)
    startDrag(tool, 0.5, 0.5, 0, -0.3)
    // Pushed below a sheet still adds: blue, a new Object.
    expect(ghostColours(preview)).toContain(PREVIEW_EXTRUDE_NEW_FALLBACK)
    tool.onPointerDown(on(0.5, 0.5, -0.3), { origin: [5.5, 0.5, -0.3], direction: [-1, 0, 0] })
    expect(onToast).not.toHaveBeenCalled()
    const after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    const fresh = after.find((o) => !before.includes(o))!
    expect(materialNames(scene, fresh)).toEqual([PLA])
    expect(materialNames(scene, sheet)).toEqual([PETG])
    expect(measure(scene, sheet).volume).toBeNull()

    expectRefused(thrown(() => scene.thicken_sheet(sheet, 0, 0.1)), PETG, PLA)
    selectFilament(PETG)
    scene.thicken_sheet(sheet, 0, 0.1)
    expect(measure(scene, sheet).volume).toBeCloseTo(0.1, 9)
  })
})

describe('Push/Pull on a face of the selected filament', () => {
  it('grows the Object as before, and Ctrl/Cmd still extrudes a new one', () => {
    const box = makeBox(scene)
    drawOnTop(scene, box)
    const before = objects(scene)
    const { tool, preview } = harness(scene)
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).not.toContain('This face is')
    startDrag(tool, 0.5, 0.5, 1, 1.5)
    expect(ghostColours(preview)).not.toContain(PREVIEW_EXTRUDE_NEW_FALLBACK)
    tool.onPointerDown(on(0.5, 0.5, 1.5), { origin: [5.5, 0.5, 1.5], direction: [-1, 0, 0] })
    expect(objects(scene)).toEqual(before)
    expect(measure(scene, box).volume).toBeCloseTo(1 + 0.25 * 0.5, 9)

    tool.toggleExtrudeAsNew()
    pushPull(tool, 0.1, 0.1, 1, 1.5)
    const after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    expect(materialNames(scene, after.find((o) => !before.includes(o))!)).toEqual([PETG])
  })
})

describe('with no filament selected', () => {
  it('Push/Pull behaves as upstream: a pull out of any face grows it', () => {
    const box = makeBox(scene)
    drawOnTop(scene, box)
    resetFilamentsForTest([], null)
    expect(differsFromSelected(scene, box)).toBe(false)
    const before = objects(scene)
    const { tool } = harness(scene)
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).toBe('Click a face to push or pull it — double-click repeats the last distance.')
    pushPull(tool, 0.5, 0.5, 1, 1.5)
    expect(objects(scene)).toEqual(before)
    expect(measure(scene, box).volume).toBeCloseTo(1 + 0.25 * 0.5, 9)
  })

  it('a Scene not wrapped for filaments never differs (upstream Hew)', () => {
    const bare = new Scene() as unknown as WasmScene
    const box = makeBox(bare)
    expect(filamentDifference(bare, box)).toBeNull()
  })
})

describe('the filament decision', () => {
  it('names the Object\'s and the selected filament, and counts an Object with no filament as different', () => {
    const box = makeBox(scene)
    expect(filamentDifference(scene, box)).toBeNull()
    selectFilament(PLA)
    expect(filamentDifference(scene, box)).toEqual({ object: PETG, selected: PLA })
    expect(filamentDifference(scene, box, { face: topFace(scene) })).toEqual({ object: PETG, selected: PLA })
    // An Object made while no filament was selected has none.
    resetFilamentsForTest([], null)
    const plain = makeBox(scene, 6)
    resetFilamentsForTest(GENERIC_FILAMENTS, PLA)
    expect(filamentDifference(scene, plain)).toEqual({ object: 'no filament', selected: PLA })
  })

  it('follows undo: the answer moves with the document', () => {
    const box = makeBox(scene)
    selectFilament(PLA)
    expect(differsFromSelected(scene, box)).toBe(true)
    scene.scene_undo().free()
    // The box is gone; a new PLA box differs from nothing.
    const pla = makeBox(scene, 3)
    expect(differsFromSelected(scene, pla)).toBe(false)
  })
})

/** The error a call throws, or null. */
function thrown(call: () => unknown): unknown {
  try {
    call()
  } catch (err) {
    return err
  }
  return null
}

function expectRefused(err: unknown, ...names: string[]): void {
  expect(parseKernelErrorCode(err)).toBe(FILAMENT_REFUSAL_CODE)
  const text = friendlyErrorText(err)
  const raw = err instanceof Error ? err.message : String(err)
  expect(kernelErrorMessage(FILAMENT_REFUSAL_CODE, raw)).toBe(text)
  for (const n of names) expect(text).toContain(n)
}

describe('unions across filaments', () => {
  /** A PETG box and an overlapping PLA box. */
  function twoFilaments(): [bigint, bigint] {
    const a = makeBox(scene)
    selectFilament(PLA)
    const b = makeBox(scene, 0.5, 0.5)
    return [a, b]
  }

  it('refuses a union of a PETG and a PLA Object, naming both, and changes nothing', () => {
    const [a, b] = twoFilaments()
    const depth = scene.undo_depth()
    const before = objects(scene)
    expectRefused(thrown(() => scene.boolean(0, a, b)), PETG, PLA)
    expectRefused(thrown(() => scene.boolean_nodes(0, 0, a, 0, b)), PETG, PLA)
    expectRefused(thrown(() => scene.boolean_nodes_many(0, Uint8Array.of(0, 0), BigUint64Array.of(a, b))), PETG, PLA)
    expect(objects(scene)).toEqual(before)
    expect(scene.undo_depth()).toBe(depth)
  })

  it('counts every Object inside a group operand', () => {
    const [a, b] = twoFilaments()
    const c = makeBox(scene, 3)
    selectFilament(PETG)
    const d = makeBox(scene, 3.5, 0.5)
    const g = scene.group_nodes(Uint8Array.of(0, 0), BigUint64Array.of(a, c))
    // A PETG box and a PLA box in one group, unioned with a PETG box.
    expectRefused(thrown(() => scene.boolean_nodes(0, 1, g, 0, d)), PETG, PLA)
    void b
  })

  it('refuses a union inside a component of members of two filaments', () => {
    const [a, b] = twoFilaments()
    const instance = scene.make_component(Uint8Array.of(0, 0), BigUint64Array.of(a, b))
    const def = scene.instance_def(instance)!
    const members = Array.from(scene.component_member_objects(def))
    expectRefused(thrown(() => scene.boolean_in_component_many(def, 0, BigUint64Array.from(members))), PETG, PLA)
  })

  it('unions two PETG Objects, whatever is selected', () => {
    const a = makeBox(scene)
    const b = makeBox(scene, 0.5, 0.5)
    selectFilament(PLA)
    const r = scene.boolean(0, a, b)
    expect(materialNames(scene, r)).toEqual([PETG])
  })

  it('subtracts PLA from PETG: a PETG Object whose carved walls are PETG', () => {
    const [a, b] = twoFilaments()
    const r = scene.boolean(1, a, b)
    expect(materialNames(scene, r)).toEqual([PETG])
    expect(measure(scene, r).volume).toBeCloseTo(1 - 0.25, 9)
    // A carved wall: the face at x = 0.5 inside the old box.
    const pick = scene.pick_face(0.75, 0.25, 10, 0, 0, -1)!
    const pair = scene.face_material(pick.object(), pick.face())!
    pick.free()
    expect(pair.face()).toBe(0xffff_ffff_ffff_ffffn)
    expect(scene.material_info(pair.object_default())?.name()).toBe(PETG)
    pair.free()
  })

  it('intersects across filaments, keeping operand A\'s', () => {
    const [a, b] = twoFilaments()
    const r = scene.boolean(2, b, a)
    expect(materialNames(scene, r)).toEqual([PLA])
  })

  it('refuses Link Similar of a PLA box into a PETG set', () => {
    const a = makeBox(scene)
    selectFilament(PLA)
    const b = makeBox(scene, 3)
    const set = scene.wrap_linked(0, a)
    const pose = Float64Array.of(1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0)
    expectRefused(thrown(() => scene.join_linked(set, b, pose)), PETG, PLA)
    selectFilament(PETG)
    const c = makeBox(scene, 6)
    expect(() => scene.join_linked(set, c, Float64Array.of(1, 0, 0, 6, 0, 1, 0, 0, 0, 0, 1, 0))).not.toThrow()
  })
})

describe('operations that would add to an Object of another filament', () => {
  it('push_pull_in_component: refused out of a PETG member with PLA selected, allowed in, and allowed with PETG', () => {
    const box = makeBox(scene)
    const instance = scene.make_component(Uint8Array.of(0), BigUint64Array.of(box))
    const def = scene.instance_def(instance)!
    const [member] = Array.from(scene.component_member_objects(def))
    const pick = scene.pick_face(0.5, 0.5, 10, 0, 0, -1)!
    const face = pick.face()
    pick.free()
    selectFilament(PLA)
    expectRefused(thrown(() => scene.push_pull_in_component(instance, member, face, 0.2)), PETG, PLA)
    scene.push_pull_in_component(instance, member, face, -0.2).free()
    selectFilament(PETG)
    scene.push_pull_in_component(instance, member, face, 0.4).free()
    expect(JSON.parse(scene.measure_json(2, instance)).volume).toBeCloseTo(1.2, 9)
  })

  it('Push/Pull inside a component says why it cannot pull a PETG face out in PLA, and the click is refused', () => {
    const box = makeBox(scene)
    const instance = scene.make_component(Uint8Array.of(0), BigUint64Array.of(box))
    const def = scene.instance_def(instance)!
    selectFilament(PLA)
    const { tool, onToast } = harness(scene)
    tool.setEditContext({ kind: 'instance', id: instance, component: def })
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).toBe(`This face is ${PETG}: pushing it in cuts it, but it can't be pulled out in ${PLA} here.`)
    startDrag(tool, 0.5, 0.5, 1, 1.5)
    expect(tool.statusHint()).toContain(`This face is ${PETG}, so it can't be pulled out in ${PLA} here.`)
    tool.onPointerDown(on(0.5, 0.5, 1.5), { origin: [5.5, 0.5, 1.5], direction: [-1, 0, 0] })
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][0]).toContain(PETG)
    expect(JSON.parse(scene.measure_json(2, instance)).volume).toBeCloseTo(1, 9)
  })

  it('push_pull called directly: refused out of a PETG face with PLA selected, a cut allowed', () => {
    const box = makeBox(scene)
    const face = topFace(scene)
    selectFilament(PLA)
    expectRefused(thrown(() => scene.push_pull(box, face, 0.2)), PETG, PLA)
    scene.push_pull(box, face, -0.2).free()
    expect(measure(scene, box).volume).toBeCloseTo(0.8, 9)
  })

  it('blend_edges: rounding an outside edge of a PETG Object is allowed with PLA selected; filling an inside corner is refused, and allowed with PETG', () => {
    // A PETG box with a step on top across its whole depth: the step's foot
    // (x = 0.5, z = 1) is an inside corner.
    const box = makeBox(scene)
    const d = scene.draft_begin_face(box, topFace(scene), 'Rectangle')
    const loop: Array<[number, number]> = [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]
    for (let i = 0; i < 4; i++) scene.draft_add_segment(d, loop[i][0], loop[i][1], 1, loop[(i + 1) % 4][0], loop[(i + 1) % 4][1], 1).free()
    scene.draft_end(d)
    scene.push_pull(box, topFace(scene, 0.25, 0.5), 0.5).free()
    selectFilament(PLA)
    const volume = measure(scene, box).volume
    const depth = scene.undo_depth()
    const inside = scene.pick_solid_edge(0.51, 0.5, 10, 0, 0, -1, 0.02)!
    const insideSpec = JSON.stringify({ edges: [String(inside.edge())], profile: { kind: 'round', radius: 0.05, segments: 4 } })
    inside.free()
    expectRefused(thrown(() => scene.blend_edges(box, insideSpec)), PETG, PLA)
    expect(measure(scene, box).volume).toBeCloseTo(volume, 12)
    expect(scene.undo_depth()).toBe(depth)

    const outside = scene.pick_solid_edge(0.996, 0.5, 10, 0, 0, -1, 0.02)!
    const outsideSpec = JSON.stringify({ edges: [String(outside.edge())], profile: { kind: 'round', radius: 0.05, segments: 4 } })
    outside.free()
    scene.blend_edges(box, outsideSpec).free()
    expect(measure(scene, box).volume).toBeLessThan(volume)

    selectFilament(PETG)
    const again = scene.pick_solid_edge(0.51, 0.5, 10, 0, 0, -1, 0.02)!
    const againSpec = JSON.stringify({ edges: [String(again.edge())], profile: { kind: 'round', radius: 0.05, segments: 4 } })
    again.free()
    const grown = measure(scene, box).volume
    scene.blend_edges(box, againSpec).free()
    expect(measure(scene, box).volume).toBeGreaterThan(grown)
  })

  it('project_depth: an emboss on a PETG Object is refused with PLA selected, an engrave allowed', () => {
    const box = makeBox(scene)
    selectFilament(PLA)
    // A free square above the box, projected down onto its top.
    const sketch = scene.begin_sketch_on_plane(0, 0, 2, 0, 0, 1)
    const c: Array<[number, number]> = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]
    for (let i = 0; i < 4; i++) scene.sketch_add_segment(sketch, c[i][0], c[i][1], 2, c[(i + 1) % 4][0], c[(i + 1) % 4][1], 2)
    const faces = scene.project_imprint(box, sketch, new BigUint64Array())
    expectRefused(thrown(() => scene.project_depth(box, sketch, faces, -0.1, 0)), PETG, PLA)
    scene.project_depth(box, sketch, faces, 0.1, 0).free()
    expect(measure(scene, box).volume).toBeLessThan(1)
  })
})

describe('Ctrl/Cmd + push into a face of another filament: an inlay', () => {
  /** The goal's PETG box with a rectangle on its top, PLA selected, Ctrl on. */
  function inlaySetup() {
    const box = petgBoxWithRectangle()
    const h = harness(scene)
    h.tool.toggleExtrudeAsNew()
    return { box, ...h }
  }

  /** Click the rectangle and type a signed distance. */
  function typed(tool: PushPullTool, text: string): void {
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    tool.onPointerDown(on(0.5, 0.5, 1), down(0.5, 0.5))
    type(tool, text)
  }

  it('cuts a 3 mm pocket and fills it with a PLA Object, in one undo step', () => {
    const { box, tool, onToast } = inlaySetup()
    const before = objects(scene)
    const depth = scene.undo_depth()
    typed(tool, '-0.003')

    expect(onToast).not.toHaveBeenCalled()
    const after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    const inlay = after.find((o) => !before.includes(o))!
    expect(materialNames(scene, box)).toEqual([PETG])
    expect(materialNames(scene, inlay)).toEqual([PLA])
    const filled = measure(scene, inlay)
    expect(filled.volume).toBeCloseTo(0.5 * 0.5 * 0.003, 12)
    expect(measure(scene, box).volume).toBeCloseTo(1 - filled.volume, 12)
    expect(measure(scene, box).volume + filled.volume).toBeCloseTo(1, 12)
    // The filling sits in the pocket: flush with the top, down to its floor.
    expect(filled.bbox.max[2]).toBeCloseTo(1, 12)
    expect(filled.bbox.min[2]).toBeCloseTo(0.997, 12)
    expect(filled.bbox.min[0]).toBeCloseTo(0.25, 12)
    expect(filled.bbox.max[0]).toBeCloseTo(0.75, 12)
    expect(scene.undo_depth()).toBe(depth + 1)
    const entries = JSON.parse(scene.history_entries_json()) as { undo: { label: string }[] }
    expect(entries.undo[entries.undo.length - 1].label).toBe('Inlay')

    scene.scene_undo().free()
    expect(objects(scene)).toEqual(before)
    expect(measure(scene, box).volume).toBeCloseTo(1, 12)
    expect(inUse(scene, PLA)).toBe(false)

    scene.scene_redo().free()
    expect(objects(scene)).toEqual(after)
    expect(materialNames(scene, box)).toEqual([PETG])
    expect(materialNames(scene, inlay)).toEqual([PLA])
    expect(measure(scene, box).volume + measure(scene, inlay).volume).toBeCloseTo(1, 12)
  })

  it('says "inlay" and names both filaments, while hovering, dragging in, and in the retype window', () => {
    const { tool, preview } = inlaySetup()
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).toBe(`This face is ${PETG}: pushing it in inlays a new ${PLA} object, pulling it out makes one. Ctrl is on.`)
    startDrag(tool, 0.5, 0.5, 1, 0.8)
    expect(tool.statusHint()).toBe(
      `Inlays ${PLA} into this ${PETG} face: cuts a pocket and fills it with a new ${PLA} object. Click to commit — or type an exact distance.`,
    )
    expect(ghostColours(preview)).toContain(PREVIEW_EXTRUDE_NEW_FALLBACK)
    // Back out of the face: a new Object pulled out, as before.
    tool.onPointerMove(on(0.5, 0.5, 1.3), { origin: [5.5, 0.5, 1.3], direction: [-1, 0, 0] })
    expect(tool.statusHint()).not.toContain('Inlays')
    tool.onPointerMove(on(0.5, 0.5, 0.8), { origin: [5.5, 0.5, 0.8], direction: [-1, 0, 0] })
    type(tool, '0.003')
    expect(tool.statusHint()).toContain(`redo the ${PLA} inlay in ${PETG}`)
  })

  it('a retyped distance redoes the inlay at that depth, and a flipped sign pulls a new Object out instead', () => {
    const { box, tool } = inlaySetup()
    const before = objects(scene)
    typed(tool, '-0.003')
    type(tool, '0.005')
    let after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    let inlay = after.find((o) => !before.includes(o))!
    expect(measure(scene, inlay).volume).toBeCloseTo(0.25 * 0.005, 12)
    expect(measure(scene, box).volume).toBeCloseTo(1 - 0.25 * 0.005, 12)

    type(tool, '-0.004')
    after = objects(scene)
    expect(after).toHaveLength(before.length + 1)
    inlay = after.find((o) => !before.includes(o))!
    expect(measure(scene, box).volume).toBeCloseTo(1, 12)
    expect(measure(scene, inlay).bbox.min[2]).toBeCloseTo(1, 12)
    expect(measure(scene, inlay).bbox.max[2]).toBeCloseTo(1.004, 12)
  })

  it('a refused half refuses the whole step: history and document unchanged', () => {
    const { box, tool, onToast } = inlaySetup()
    const before = objects(scene)
    const depth = scene.undo_depth()
    const history = scene.history_entries_json()
    const hash = scene.state_hash()
    vi.spyOn(scene, 'push_pull').mockImplementation(() => {
      throw new Error('Obstructed: the push is blocked')
    })
    typed(tool, '-0.003')
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(objects(scene)).toEqual(before)
    expect(scene.undo_depth()).toBe(depth)
    expect(scene.history_entries_json()).toBe(history)
    expect(scene.state_hash()).toBe(hash)
    expect(measure(scene, box).volume).toBeCloseTo(1, 12)
  })

  it('a push right through the part takes the filling through with it', () => {
    const { tool, onToast } = inlaySetup()
    const before = objects(scene)
    typed(tool, '-1')
    expect(onToast).not.toHaveBeenCalled()
    const after = objects(scene)
    const pla = after.filter((o) => materialNames(scene, o)[0] === PLA)
    const petg = after.filter((o) => materialNames(scene, o)[0] === PETG)
    expect(pla).toHaveLength(1)
    expect(measure(scene, pla[0]).volume).toBeCloseTo(0.25, 12)
    expect(measure(scene, pla[0]).bbox.min[2]).toBeCloseTo(0, 12)
    const petgVolume = petg.reduce((v, o) => v + measure(scene, o).volume, 0)
    expect(petgVolume).toBeCloseTo(0.75, 12)
    scene.scene_undo().free()
    expect(objects(scene)).toEqual(before)
  })

  it('not on a linked copy: the push would cut every copy, so Ctrl/Cmd + push stays a new Object and the set is untouched', () => {
    const box = petgBoxWithRectangle()
    const set = scene.wrap_linked(0, box)
    const before = objects(scene)
    const { tool, onToast } = harness(scene)
    tool.setFaceEligibility((_o, instance) => instance === undefined || scene.is_linked(instance))
    tool.toggleExtrudeAsNew()
    tool.onPointerMove(on(0.5, 0.5, 1), down(0.5, 0.5))
    expect(tool.statusHint()).not.toContain('inlay')
    typed(tool, '-0.003')
    expect(onToast).not.toHaveBeenCalled()
    expect(objects(scene)).toHaveLength(before.length + 1)
    expect(JSON.parse(scene.measure_json(2, set)).volume).toBeCloseTo(1, 12)
  })

  it('same filament: Ctrl/Cmd + push stays as upstream, a new Object overlapping the untouched box', () => {
    const box = makeBox(scene)
    drawOnTop(scene, box)
    const before = objects(scene)
    const { tool } = harness(scene)
    tool.toggleExtrudeAsNew()
    typed(tool, '-0.003')
    expect(objects(scene)).toHaveLength(before.length + 1)
    expect(measure(scene, box).volume).toBeCloseTo(1, 12)
  })
})

describe('reopening a document with a linked set', () => {
  it('keeps a PETG linked set PETG while PLA is selected', () => {
    const box = makeBox(scene)
    const set = scene.wrap_linked(0, box)
    // A second copy, placed as a linked paste places one: with the set's own material.
    const copy = scene.place_instance(scene.instance_def(set)!, Float64Array.of(1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0))
    scene.set_instance_material(copy, scene.instance_appearance_material(set))
    const saved = new Uint8Array(scene.save())

    selectFilament(PLA)
    const reopened = withBuildFilament(new Scene() as unknown as WasmScene)
    reopened.load(saved)
    const depth = reopened.undo_depth()
    flattenDocument(reopened)
    const placements = Array.from(reopened.instance_ids())
    expect(placements.length).toBeGreaterThan(0)
    for (const instance of placements) {
      const def = reopened.instance_def(instance)!
      for (const member of Array.from(reopened.component_member_objects(def))) {
        expect(filamentDifference(reopened, member, { instance })).toEqual({ object: PETG, selected: PLA })
      }
    }
    expect(reopened.undo_depth()).toBe(depth)
    expect(inUse(reopened, PLA)).toBe(false)
  })

  it('still gives a document from before filaments the selected filament', () => {
    resetFilamentsForTest([], null)
    makeBox(scene)
    const saved = new Uint8Array(scene.save())
    resetFilamentsForTest(GENERIC_FILAMENTS, PLA)
    const reopened = withBuildFilament(new Scene() as unknown as WasmScene)
    reopened.load(saved)
    flattenDocument(reopened)
    const [only] = Array.from(reopened.object_ids())
    expect(materialNames(reopened, only)).toEqual([PLA])
  })
})
