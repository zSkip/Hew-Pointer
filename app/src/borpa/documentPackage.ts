/**
 * The kernel side of Borpa's 3MF documents (`borpaFileHost.ts`): a 3MF any
 * slicer opens, carrying the editable document inside
 * (`crates/wasm-api`'s `document_to_3mf` / `document_from_3mf`). Called only
 * after the kernel has loaded (a save or open needs a scene first).
 */

import { document_from_3mf, document_to_3mf } from '../wasm/pkg/wasm_api.js'
import { BorpaFileHost, NoEditableModelError, type DocumentCodec } from './borpaFileHost'

export const wasmDocumentCodec: DocumentCodec = {
  pack: (document) => document_to_3mf(document),
  unpack: (file) => document_from_3mf(file) ?? null,
}

/** The FileHost App.tsx uses inside Borpa. */
export function makeBorpaFileHost(): BorpaFileHost {
  return new BorpaFileHost(wasmDocumentCodec)
}

/**
 * The document bytes in a file read outside the FileHost (Revert re-reading
 * the bound file, a drop): a `.3mf` is unpacked, anything else is returned
 * as it is. Throws `NoEditableModelError` for a 3MF with no model inside.
 */
export function documentBytesFromFile(bytes: Uint8Array, name: string, codec: DocumentCodec = wasmDocumentCodec): Uint8Array {
  if (!/\.3mf$/i.test(name)) return bytes
  const document = codec.unpack(bytes)
  if (document === null) throw new NoEditableModelError(name)
  return document
}
