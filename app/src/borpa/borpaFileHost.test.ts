// @vitest-environment jsdom
/**
 * BorpaFileHost: inside Borpa a document is saved as a 3MF carrying the
 * editable model, and opened back out of one; `.hew` appears in no picker.
 * The codec is a stand-in here (the real one is covered by
 * documentPackage.wasm.test.ts); the File System Access pickers are stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BorpaFileHost, NoEditableModelError, threeMfName, type DocumentCodec } from './borpaFileHost'
import { documentBytesFromFile } from './documentPackage'
import { WebFileHost } from '../io/webFileHost'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** pack: "3MF[" + doc + "]"; unpack: the inside, null for "PLAIN", throws otherwise. */
const codec: DocumentCodec = {
  pack: (d) => enc.encode(`3MF[${dec.decode(d)}]`),
  unpack: (b) => {
    const s = dec.decode(b)
    if (s === 'PLAIN') return null
    const m = /^3MF\[(.*)\]$/s.exec(s)
    if (m === null) throw new Error('NotAPackage: not a zip')
    return enc.encode(m[1])
  },
}

interface FakeHandle {
  name: string
  written: Uint8Array[]
  getFile: () => Promise<File>
  createWritable: () => Promise<{ write: (b: Uint8Array) => Promise<void>; close: () => Promise<void> }>
  queryPermission: () => Promise<PermissionState>
  requestPermission: () => Promise<PermissionState>
  move?: (name: string) => Promise<void>
}

function fakeHandle(name: string, content = ''): FakeHandle {
  const h: FakeHandle = {
    name,
    written: [],
    getFile: async () => new File([content], h.name),
    createWritable: async () => ({
      write: async (b: Uint8Array) => {
        h.written.push(b)
      },
      close: async () => {},
    }),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    move: async (n: string) => {
      h.name = n
    },
  }
  return h
}

type Win = Record<string, unknown>

function stubPickers(opts: { open?: FakeHandle; save?: FakeHandle }) {
  const openPicker = vi.fn(async (_o: { types: FilePickerAcceptType[] }) => (opts.open ? [opts.open] : []))
  const savePicker = vi.fn(async (_o: { suggestedName: string; types: FilePickerAcceptType[] }) => opts.save)
  ;(window as unknown as Win).showOpenFilePicker = openPicker
  ;(window as unknown as Win).showSaveFilePicker = savePicker
  return { openPicker, savePicker }
}

/** Every extension any picker call was offered. */
function offeredExtensions(picker: { mock: { calls: Array<[{ types: FilePickerAcceptType[] }]> } }): string[] {
  return picker.mock.calls.flatMap(([o]) => o.types.flatMap((ty) => Object.values(ty.accept).flat() as string[]))
}

afterEach(() => {
  delete (window as unknown as Win).showOpenFilePicker
  delete (window as unknown as Win).showSaveFilePicker
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('threeMfName', () => {
  it('replaces a known extension with .3mf', () => {
    expect(threeMfName('Chair.hew')).toBe('Chair.3mf')
    expect(threeMfName('Chair.skp')).toBe('Chair.3mf')
    expect(threeMfName('Chair.3mf')).toBe('Chair.3mf')
    expect(threeMfName('Chair')).toBe('Chair.3mf')
  })
})

describe('BorpaFileHost save', () => {
  it('Save As writes a packed 3MF to the picked file, offering only .3mf', async () => {
    const target = fakeHandle('Chair.3mf')
    const { savePicker } = stubPickers({ save: target })
    const ref = await new BorpaFileHost(codec).saveAs(enc.encode('DOC'), 'Chair.hew', 'hew')
    expect(ref).toEqual({ name: 'Chair.3mf', format: 'hew', handle: target })
    expect(dec.decode(target.written[0])).toBe('3MF[DOC]')
    expect(savePicker.mock.calls[0][0].suggestedName).toBe('Chair.3mf')
    expect(offeredExtensions(savePicker)).toEqual(['.3mf'])
  })

  it('Save As forces the .3mf extension on a name typed without it', async () => {
    const target = fakeHandle('Chair')
    stubPickers({ save: target })
    const ref = await new BorpaFileHost(codec).saveAs(enc.encode('DOC'), 'Chair')
    expect(ref?.name).toBe('Chair.3mf')
  })

  it('Save writes in place over the bound 3MF without a picker', async () => {
    const bound = fakeHandle('Chair.3mf')
    const { savePicker } = stubPickers({})
    const ref = await new BorpaFileHost(codec).save(enc.encode('DOC2'), { name: 'Chair.3mf', format: 'hew', handle: bound })
    expect(savePicker).not.toHaveBeenCalled()
    expect(ref).toEqual({ name: 'Chair.3mf', format: 'hew', handle: bound })
    expect(dec.decode(bound.written[0])).toBe('3MF[DOC2]')
  })

  it('Save never overwrites a legacy .hew with a 3MF: it asks where', async () => {
    const legacy = fakeHandle('Old.hew')
    const target = fakeHandle('Old.3mf')
    const { savePicker } = stubPickers({ save: target })
    const ref = await new BorpaFileHost(codec).save(enc.encode('DOC'), { name: 'Old.hew', format: 'hew', handle: legacy })
    expect(legacy.written).toHaveLength(0)
    expect(savePicker).toHaveBeenCalledOnce()
    expect(ref?.name).toBe('Old.3mf')
  })

  it('Save of an unsaved document asks for a 3MF', async () => {
    const target = fakeHandle('Untitled.3mf')
    const { savePicker } = stubPickers({ save: target })
    await new BorpaFileHost(codec).save(enc.encode('DOC'), null)
    expect(savePicker.mock.calls[0][0].suggestedName).toBe('Untitled.3mf')
  })

  it('a canceled picker saves nothing', async () => {
    ;(window as unknown as Win).showOpenFilePicker = vi.fn()
    ;(window as unknown as Win).showSaveFilePicker = vi.fn(async () => {
      throw new DOMException('cancel', 'AbortError')
    })
    expect(await new BorpaFileHost(codec).saveAs(enc.encode('DOC'), 'Chair')).toBeNull()
  })

  it('a SketchUp format is handed to the web host unchanged', async () => {
    const inner = new WebFileHost()
    const spy = vi.spyOn(inner, 'saveAs').mockResolvedValue(null)
    await new BorpaFileHost(codec, inner).saveAs(enc.encode('SKP'), 'Chair.skp', 'skp2026')
    expect(spy).toHaveBeenCalledWith(enc.encode('SKP'), 'Chair.skp', 'skp2026')
  })
})

describe('BorpaFileHost open', () => {
  it('a 3MF with a model inside opens as the document, keeping its handle', async () => {
    const file = fakeHandle('Chair.3mf', '3MF[DOC]')
    const { openPicker } = stubPickers({ open: file })
    const pick = await new BorpaFileHost(codec).openAny()
    expect(pick).toEqual({ kind: 'hew', name: 'Chair.3mf', bytes: enc.encode('DOC'), handle: file })
    expect(offeredExtensions(openPicker)).toContain('.3mf')
    expect(offeredExtensions(openPicker)).not.toContain('.hew')
  })

  it('a 3MF without a model inside is refused with a clear error', async () => {
    stubPickers({ open: fakeHandle('Plate.3mf', 'PLAIN') })
    await expect(new BorpaFileHost(codec).openAny()).rejects.toBeInstanceOf(NoEditableModelError)
  })

  it('a file that is not a package is refused in plain words', async () => {
    stubPickers({ open: fakeHandle('Broken.3mf', 'garbage') })
    await expect(new BorpaFileHost(codec).openAny()).rejects.toThrow(/isn't a 3MF/)
  })

  it('an import format goes through the web host as an import', async () => {
    const inner = new WebFileHost()
    const stl = { kind: 'stl' as const, name: 'Part.stl', bytes: enc.encode('solid') }
    const spy = vi.spyOn(inner, 'resolveImportPick').mockResolvedValue(stl)
    stubPickers({ open: fakeHandle('Part.stl', 'solid') })
    expect(await new BorpaFileHost(codec, inner).openAny()).toBe(stl)
    const [bytes, name] = spy.mock.calls[0]
    expect(dec.decode(bytes)).toBe('solid')
    expect(name).toBe('Part.stl')
  })

  it('without the picker API the fallback input offers no .hew', () => {
    void new BorpaFileHost(codec).openAny()
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    expect(input.accept).toBe('.3mf,.dae,.skp,.glb,.gltf,.stl')
    void new BorpaFileHost(codec).open()
    const inputs = document.querySelectorAll('input[type=file]')
    expect((inputs[1] as HTMLInputElement).accept).toBe('.3mf')
  })
})

describe('documentBytesFromFile', () => {
  it('unpacks a .3mf and passes anything else through', () => {
    expect(dec.decode(documentBytesFromFile(enc.encode('3MF[DOC]'), 'a.3mf', codec))).toBe('DOC')
    expect(dec.decode(documentBytesFromFile(enc.encode('RAW'), 'a.hew', codec))).toBe('RAW')
    expect(() => documentBytesFromFile(enc.encode('PLAIN'), 'a.3mf', codec)).toThrow(NoEditableModelError)
  })
})
