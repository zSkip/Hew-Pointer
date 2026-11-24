/**
 * New geometry is built in the selected filament.
 *
 * `withBuildFilament` wraps the kernel's Scene so every operation that makes
 * Objects (extrude, extrude as new, Follow Me, Revolve, Loft, Make Solid,
 * Thicken, 3D text) gives the Objects it made the selected filament, in the
 * same undo step: the operation and the assignment run inside one history
 * bracket, labeled as the operation's own step. An import gives every Object
 * it brought in the filament, clearing the colours and textures it came with,
 * in the import's own step the same way.
 *
 * A refused operation throws its own error unchanged, and the bracket is
 * aborted on the way out, so no empty or half-applied step is left behind.
 * Redo replays the step whole: the Object and its filament come back
 * together.
 *
 * Wrapping the Scene is the one shared place every tool, panel and menu
 * command already goes through, so no tool needs to know about filaments.
 * The operations' own results are returned unchanged; a failure to assign is
 * logged and leaves the operation as the kernel made it.
 *
 * The same wrapper refuses what would mix filaments in one Object: a union
 * across filaments, and material added to an Object of another filament than
 * the selected one (filamentRules.ts). Push/Pull alone also asks first
 * (borpa/objectFilament.ts), to pull a new Object out of such a face.
 */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { inHistoryBracket } from '../tools/transformSelection'
import type { Scene as WasmScene } from '../wasm/loader'
import { assignFilament, type AssignMode } from './buildMaterial'
import { FILAMENT_GUARDS, topEntryLabel } from './filamentRules'
import { selectedFilament } from './filaments'
import { registerFilamentScene } from './objectFilament'

/** Methods that make new Objects from sketches, faces or sheets. */
const CREATING = /^(extrude_region|extrude_face_as_new_object|follow_me_|revolve$|revolve_in_instance$|loft$|make_solid_from_sketches$|thicken_sheet|place_text$)/
/** Imports: everything they bring in takes the filament. */
const IMPORTING = /^import_(stl|gltf|dae|skp)$/

export const ASSIGN_FILAMENT_LABEL = msg`Assign filament`

type ObjectScene = Pick<WasmScene, 'object_ids' | 'component_ids' | 'component_member_objects'>

/** Every live Object: in the world, in groups, and in component definitions. */
export function allObjectIds(scene: ObjectScene): Set<bigint> {
  const out = new Set<bigint>(scene.object_ids())
  for (const c of scene.component_ids()) for (const o of scene.component_member_objects(c)) out.add(o)
  return out
}

/** A document from before filaments: every Object whose base material is no
 *  filament, or that carries per-face paint, takes the selected filament. */
export function flattenDocument(scene: WasmScene): void {
  giveFilament(scene, [...allObjectIds(scene)], 'unlinked')
}

function giveFilament(scene: WasmScene, objects: readonly bigint[], mode: AssignMode): void {
  const filament = selectedFilament()
  if (filament === null || objects.length === 0) return
  assignFilament(scene, filament, objects, mode, i18n._(ASSIGN_FILAMENT_LABEL))
}

/**
 * Run `method` and give the Objects it made the selected filament, as one
 * undo step labeled as the operation. `mode` is `'unassigned'` for modelling
 * operations (a piece split off an Object keeps its filament) and `'all'` for
 * imports.
 */
function runBuilding(proxy: WasmScene, target: WasmScene, method: (...a: unknown[]) => unknown, args: unknown[], mode: AssignMode): unknown {
  if (selectedFilament() === null) return method.apply(target, args)
  let label = ''
  return inHistoryBracket(
    proxy,
    // Read when the bracket commits: the operation's own label.
    () => label,
    () => {
      const before = allObjectIds(target)
      const result = method.apply(target, args)
      label = topEntryLabel(target) ?? i18n._(ASSIGN_FILAMENT_LABEL)
      const made = [...allObjectIds(target)].filter((id) => !before.has(id))
      try {
        giveFilament(target, made, mode)
      } catch (err) {
        console.error('Borpa: the new Objects kept the materials they were made with', err)
      }
      return result
    },
  )
}

/**
 * The Scene, with new geometry built in the selected filament and the
 * different-filament rules (filamentRules.ts) applied. Everything else passes
 * straight through to the kernel.
 */
export function withBuildFilament(scene: WasmScene): WasmScene {
  const proxy: WasmScene = new Proxy(scene, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      const method = value as (...a: unknown[]) => unknown
      const mode: AssignMode | null = CREATING.test(prop) && !prop.includes('preview') ? 'unassigned' : IMPORTING.test(prop) ? 'all' : null
      const guard = Object.prototype.hasOwnProperty.call(FILAMENT_GUARDS, prop) ? FILAMENT_GUARDS[prop] : undefined
      if (mode === null && guard === undefined) return value
      const run = (args: unknown[]): unknown => (mode === null ? method.apply(target, args) : runBuilding(proxy, target, method, args, mode))
      if (guard === undefined) return (...args: unknown[]) => run(args)
      return (...args: unknown[]) => guard(proxy, target, args, () => run(args))
    },
  })
  registerFilamentScene(proxy, scene)
  return proxy
}
