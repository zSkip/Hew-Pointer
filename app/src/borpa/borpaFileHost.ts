/**
 * Borpa's FileHost — documents are saved as 3MF files, not `.hew`.
 *
 * Inside Borpa (`isBorpa`) the person never sees a `.hew` file. Save and
 * Save As write a normal 3MF that any slicer (Borpa's own Prepare tab
 * included) opens as an ordinary model, with the editable document carried
 * inside it as one extra part (`crates/mesh-export/src/document_3mf.rs`).
 * Open reads that part back out, so the model reopens with its dimensions,
 * sketches, curves and components intact.
 *
 * Everything above this host is unchanged: App.tsx still saves the bytes of
 * `scene.save()` and opens a `{ kind: 'hew' }` pick with `scene.load()`.
 * The document format stays `'hew'` in the `FileRef` — an internal label
 * for "document bytes", never shown — so autosave, recovery, recents and the
 * save bookkeeping need nothing new. Only the bytes on disk differ: this host
 * packs them into a 3MF on the way out and unpacks them on the way in.
 *
 * Importers (SketchUp, COLLADA, glTF, STL), pictures and exports go through
 * the ordinary `WebFileHost`.
 */

import { t } from '@lingui/core/macro'
import type { DocFormat, ExportFileType, FileHost, FileRef, ImportPick, OpenPick } from '../io/fileHost'
import { WebFileHost, anchorDownloadAs } from '../io/webFileHost'
import { stripKnownExtension } from '../io/docFormat'
import { isCoarsePointer } from '../platform'

/** Packs document bytes into a 3MF and back (`documentPackage.ts`). */
export interface DocumentCodec {
  /** A 3MF carrying `document` as its editable model. */
  pack(document: Uint8Array): Uint8Array
  /** The document a 3MF carries; null when it carries none. Throws when the
   * bytes are not a package at all. */
  unpack(file: Uint8Array): Uint8Array | null
}

/** A 3MF (or other file) the person picked that has no editable model inside. */
export class NoEditableModelError extends Error {
  readonly fileName: string
  constructor(fileName: string) {
    super(t`This 3MF has no editable model inside, so it can't be opened for editing. To print it, load it on the Prepare tab.`)
    this.name = 'NoEditableModelError'
    this.fileName = fileName
  }
}

const THREE_MF_MIME = 'model/3mf'

/** `Model.skp`, `Model.hew`, `Model.3mf` -> `Model.3mf`. */
export function threeMfName(name: string): string {
  return stripKnownExtension(name) + '.3mf'
}

function documentTypes(): FilePickerAcceptType[] {
  return [{ description: t`3MF model`, accept: { [THREE_MF_MIME]: ['.3mf'] } }]
}

/** Open's single filter: a saved model plus every import format. No `.hew`:
 * an old `.hew` still opens when picked through "All files". */
function openTypes(): FilePickerAcceptType[] {
  return [
    {
      description: t`All supported files`,
      accept: {
        [THREE_MF_MIME]: ['.3mf'],
        'model/vnd.collada+xml': ['.dae'],
        'application/octet-stream': ['.skp'],
        'model/gltf-binary': ['.glb'],
        'model/gltf+json': ['.gltf'],
        'model/stl': ['.stl'],
      },
    },
  ]
}

// oxlint-disable-next-line lingui/no-unlocalized-strings -- file extensions, not copy
const OPEN_INPUT_ACCEPT = '.3mf,.dae,.skp,.glb,.gltf,.stl'

function hasFSAA(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** A FileSystemFileHandle stored in a `FileRef`, or null. */
function fileHandleOf(handle: unknown): FileSystemFileHandle | null {
  return handle instanceof Object && 'createWritable' in (handle as object) ? (handle as FileSystemFileHandle) : null
}

/** Same rule as WebFileHost: Chrome grants on picker handles, Brave asks. */
async function ensureWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(new Uint8Array(bytes))
  await writable.close()
}

interface Picked {
  bytes: Uint8Array
  name: string
  handle: FileSystemFileHandle | null
}

export class BorpaFileHost implements FileHost {
  private readonly codec: DocumentCodec
  private readonly inner: WebFileHost

  constructor(codec: DocumentCodec, inner: WebFileHost = new WebFileHost()) {
    this.codec = codec
    this.inner = inner
  }

  /** The document inside a picked file: a 3MF is unpacked; a legacy `.hew`
   * picked through "All files" is already document bytes. */
  private documentFrom(bytes: Uint8Array, name: string): Uint8Array {
    if (/\.hew$/i.test(name)) return bytes
    let document: Uint8Array | null
    try {
      document = this.codec.unpack(bytes)
    } catch {
      throw new Error(t`This file isn't a 3MF that Borpa can open.`)
    }
    if (document === null) throw new NoEditableModelError(name)
    return document
  }

  /** One file through the FSAA picker, or the hidden-input fallback. */
  private async pick(types: FilePickerAcceptType[], accept: string): Promise<Picked | null> {
    if (hasFSAA()) {
      let handles: FileSystemFileHandle[]
      try {
        handles = await showOpenFilePicker({ multiple: false, types, excludeAcceptAllOption: false })
      } catch (err) {
        if (isAbort(err)) return null
        throw err
      }
      const handle = handles[0]
      if (handle === undefined) return null
      const file = await handle.getFile()
      return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, handle }
    }
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      // Omit `accept` on coarse pointers, as WebFileHost does.
      if (!isCoarsePointer()) input.accept = accept
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', () => {
        document.body.removeChild(input)
        const file = input.files?.[0]
        if (file == null) {
          resolve(null)
          return
        }
        file.arrayBuffer()
          .then((buf) => resolve({ bytes: new Uint8Array(buf), name: file.name, handle: null }))
          .catch(() => resolve(null))
      }, { once: true })
      input.click()
    })
  }

  async open(): Promise<{ ref: FileRef; bytes: Uint8Array } | null> {
    const picked = await this.pick(documentTypes(), '.3mf')
    if (picked === null) return null
    const bytes = this.documentFrom(picked.bytes, picked.name)
    return { ref: { name: picked.name, format: 'hew', handle: picked.handle }, bytes }
  }

  async openAny(): Promise<OpenPick | null> {
    const picked = await this.pick(openTypes(), OPEN_INPUT_ACCEPT)
    if (picked === null) return null
    if (/\.(3mf|hew)$/i.test(picked.name)) {
      return { kind: 'hew', name: picked.name, bytes: this.documentFrom(picked.bytes, picked.name), handle: picked.handle }
    }
    // Every other format is an import; a `.skp` is never kept as the
    // document's own file here (App.tsx imports it), so no handle.
    return this.inner.resolveImportPick(picked.bytes, picked.name)
  }

  async save(bytes: Uint8Array, ref: FileRef | null): Promise<FileRef | null> {
    if (ref === null) {
      // oxlint-disable-next-line lingui/no-unlocalized-strings -- default file name, not copy
      return this.saveAs(bytes, 'Untitled.3mf')
    }
    if (ref.format !== 'hew') return this.inner.save(bytes, ref)
    const handle = fileHandleOf(ref.handle)
    // Write in place only over a 3MF: a document opened from a legacy
    // `.hew` is asked where to go rather than overwriting it with a 3MF.
    if (handle !== null && /\.3mf$/i.test(handle.name)) {
      if (!(await ensureWritePermission(handle))) return this.saveAs(bytes, ref.name)
      const packed = this.codec.pack(bytes)
      try {
        await writeHandle(handle, packed)
      } catch (err) {
        if (isAbort(err)) return null
        throw err
      }
      return { name: handle.name, format: 'hew', handle }
    }
    if (hasFSAA()) return this.saveAs(bytes, ref.name)
    // No picker API: download again, as WebFileHost does for a handle-less ref.
    const name = threeMfName(ref.name)
    anchorDownloadAs(this.codec.pack(bytes), name, THREE_MF_MIME)
    return { name, format: 'hew', handle: null }
  }

  async saveAs(bytes: Uint8Array, suggestedName: string, format: DocFormat = 'hew'): Promise<FileRef | null> {
    if (format !== 'hew') return this.inner.saveAs(bytes, suggestedName, format)
    const name = threeMfName(suggestedName)
    if (!hasFSAA()) {
      anchorDownloadAs(this.codec.pack(bytes), name, THREE_MF_MIME)
      return { name, format: 'hew', handle: null }
    }
    let handle: FileSystemFileHandle
    try {
      // The picker first: it needs the click's user activation, which a
      // long pack could outlast.
      handle = await showSaveFilePicker({ suggestedName: name, types: documentTypes(), excludeAcceptAllOption: false })
    } catch (err) {
      if (isAbort(err)) return null
      throw err
    }
    // `.3mf` is forced, as WebFileHost forces its formats' extensions.
    if (!handle.name.toLowerCase().endsWith('.3mf')) {
      const movable = handle as FileSystemFileHandle & { move?: (name: string) => Promise<void> }
      if (typeof movable.move !== 'function') {
        throw new Error(t`The file name must end in .3mf.`)
      }
      await movable.move(threeMfName(handle.name))
    }
    await writeHandle(handle, this.codec.pack(bytes))
    return { name: handle.name, format: 'hew', handle }
  }

  openForImport(): Promise<ImportPick | null> {
    return this.inner.openForImport()
  }

  openImage(): Promise<{ name: string; bytes: Uint8Array } | null> {
    return this.inner.openImage()
  }

  exportBinary(bytes: Uint8Array, suggestedName: string, fileType: ExportFileType): Promise<string | null> {
    return this.inner.exportBinary(bytes, suggestedName, fileType)
  }
}
