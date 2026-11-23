/**
 * driveDimension — typing a length into a linear dimension moves the model
 * (a driving dimension): the kernel pushes or pulls the face the dimension
 * ends on, or moves the object it ends on, and the dimension with it, as one
 * undo step (`set_linear_dimension_length`). Any text that is not a length
 * keeps the old meaning: a label that replaces the measured value
 * (`commitAnnotationText`).
 *
 * Import-light (no THREE/DOM) so it is unit-testable against a fake
 * `WasmScene`, like `annotationEdit`.
 */
import type { Scene as WasmScene } from '../wasm/loader'
import { friendlyErrorText } from '../kernelErrors'
import { parseLengthToMeters } from '../settings/units'
import type { AnnotationSnapshot } from './annotationEdit'

export type DriveOutcome =
  /** Not a length, or not a linear dimension: commit the text as a label. */
  | { kind: 'label' }
  /** The model and the dimension moved (one undo step). */
  | { kind: 'driven' }
  /** The kernel refused; nothing changed. `message` is for a toast. */
  | { kind: 'refused'; message: string }

/**
 * Drive the linear dimension `id` to the length typed as `text` (read in the
 * document's display units, explicit units honoured; `parse` is injectable
 * for tests). Blank text, and text the length parser rejects, return
 * `label` without touching the kernel.
 */
export function driveDimensionLength(
  wasmScene: WasmScene,
  id: bigint,
  snapshot: AnnotationSnapshot,
  text: string,
  parse: (input: string) => number | null = parseLengthToMeters,
): DriveOutcome {
  if (snapshot.kind !== 'linear') return { kind: 'label' }
  const meters = parse(text)
  if (meters === null) return { kind: 'label' }
  try {
    wasmScene.set_linear_dimension_length(id, meters).free()
  } catch (err) {
    return { kind: 'refused', message: friendlyErrorText(err) }
  }
  return { kind: 'driven' }
}
