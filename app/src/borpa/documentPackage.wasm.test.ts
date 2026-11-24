/**
 * Borpa's 3MF documents through the REAL compiled wasm module: a saved
 * document comes back byte for byte and reopens as the same document; the
 * 3MF holds an ordinary mesh; a plain 3MF says it holds no model.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { Scene } from '../wasm/pkg/wasm_api.js'
import type { Scene as WasmScene } from '../wasm/loader'
import { NoEditableModelError } from './borpaFileHost'
import { documentBytesFromFile, wasmDocumentCodec } from './documentPackage'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

beforeAll(async () => {
  const wasmBytes = await readFile(resolve(__dirname, '../wasm/pkg/wasm_api_bg.wasm'))
  await init({ module_or_path: wasmBytes })
})

/** A unit box on the ground, extruded from a sketch. */
function boxScene(): WasmScene {
  const s = new Scene() as unknown as WasmScene
  const sketch = s.begin_sketch_on_plane(0, 0, 0, 0, 0, 1)
  const c: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]
  for (let i = 0; i < 4; i++) {
    const a = c[i]
    const b = c[(i + 1) % 4]
    s.sketch_add_segment(sketch, a[0], a[1], 0, b[0], b[1], 0)
  }
  s.extrude_region(sketch, Array.from(s.sketch_regions(sketch))[0], 1)
  return s
}

describe('Borpa 3MF document (wasm)', () => {
  it('round-trips the document bytes exactly and reopens the same document', () => {
    const scene = boxScene()
    const saved = new Uint8Array(scene.save())
    const file = wasmDocumentCodec.pack(saved)
    expect(Array.from(file.subarray(0, 2))).toEqual([0x50, 0x4b]) // a zip
    const back = wasmDocumentCodec.unpack(file)
    expect(back).not.toBeNull()
    expect(Buffer.from(back!).equals(Buffer.from(saved))).toBe(true)

    const reopened = new Scene() as unknown as WasmScene
    reopened.load(documentBytesFromFile(file, 'Box.3mf'))
    expect(reopened.state_hash()).toBe(scene.state_hash())
  })

  // The package is meshed from the saved bytes, so it matches File > Export
  // 3MF of that document as it reopens. (A reopened document may list its
  // faces in another order than the live one did: the same triangles, in a
  // different sequence.)
  it('carries the mesh File > Export 3MF writes for the saved document', () => {
    const saved = new Uint8Array(boxScene().save())
    const reopened = new Scene() as unknown as WasmScene
    reopened.load(saved)
    const exported = reopened.export('3mf', 0, false)!
    const file = wasmDocumentCodec.pack(saved)
    // The model part is stored uncompressed, so its text appears verbatim.
    const text = (b: Uint8Array) => Buffer.from(b).toString('latin1')
    const model = /<\?xml version="1\.0" encoding="UTF-8"\?>\n<model [^]*?<\/model>\n/.exec(text(exported))
    expect(model).not.toBeNull()
    expect(text(file)).toContain(model![0])
  })

  it('an empty document still saves and reopens', () => {
    const scene = new Scene() as unknown as WasmScene
    const saved = new Uint8Array(scene.save())
    const back = wasmDocumentCodec.unpack(wasmDocumentCodec.pack(saved))
    expect(Buffer.from(back!).equals(Buffer.from(saved))).toBe(true)
  })

  it('a plain 3MF holds no editable model', () => {
    const plain = boxScene().export('3mf', 0, false)!
    expect(wasmDocumentCodec.unpack(plain)).toBeNull()
    expect(() => documentBytesFromFile(plain, 'Plate.3mf')).toThrow(NoEditableModelError)
  })

  it('bytes that are not a package throw', () => {
    expect(() => wasmDocumentCodec.unpack(new TextEncoder().encode('solid ascii'))).toThrow(/NotAPackage/)
  })
})
