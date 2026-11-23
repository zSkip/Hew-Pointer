/**
 * New geometry is built in the selected filament.
 *
 * `withBuildFilament` wraps the kernel's Scene so every operation that makes
 * Objects (extrude, extrude as new, Follow Me, Revolve, Loft, Make Solid,
 * Thicken, 3D text) gives the Objects it made the selected filament, in the
 * same undo step: the operation and the assignment run inside one history
 * bracket, labeled as the operation's own step. An import gives every Object
 * it brought in the filament, clearing the colours and textures it came with.
 *
 * Wrapping the Scene is the one shared place every tool, panel and menu
 * command already goes through, so no tool needs to know about filaments.
 * The operations' own results are returned unchanged; a failure to assign is
 * logged and leaves the operation as the kernel made it.
 */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { historyLabel } from '../i18n/historyLabels'
import { parseHistoryEntries } from '../panels/changesModel'
import { inHistoryBracket } from '../tools/transformSelection'
import type { Scene as WasmScene } from '../wasm/loader'
import { assignFilament, type AssignMode } from './buildMaterial'
import { selectedFilament } from './filaments'

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

/** The newest undo entry's label, as the Edit menu would show it. */
function topEntryLabel(scene: WasmScene): string | null {
  const entries = parseHistoryEntries(scene.history_entries_json())
  const top = entries.undo[entries.undo.length - 1]
  return top === undefined ? null : historyLabel(top.kind, top.label)
}

function giveFilament(scene: WasmScene, objects: readonly bigint[], mode: AssignMode): void {
  const filament = selectedFilament()
  if (filament === null || objects.length === 0) return
  assignFilament(scene, filament, objects, mode, i18n._(ASSIGN_FILAMENT_LABEL))
}

function runCreating(proxy: WasmScene, target: WasmScene, method: (...a: unknown[]) => unknown, args: unknown[]): unknown {
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
        giveFilament(target, made, 'unassigned')
      } catch (err) {
        console.error('Borpa: the new geometry kept no filament', err)
      }
      return result
    },
  )
}

function runImport(target: WasmScene, method: (...a: unknown[]) => unknown, args: unknown[]): unknown {
  const before = allObjectIds(target)
  const result = method.apply(target, args)
  try {
    giveFilament(target, [...allObjectIds(target)].filter((id) => !before.has(id)), 'all')
  } catch (err) {
    console.error('Borpa: the imported Objects kept their own materials', err)
  }
  return result
}

/**
 * The Scene, with new geometry built in the selected filament. Everything
 * else passes straight through to the kernel.
 */
export function withBuildFilament(scene: WasmScene): WasmScene {
  const proxy: WasmScene = new Proxy(scene, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      const method = value as (...a: unknown[]) => unknown
      if (CREATING.test(prop) && !prop.includes('preview')) return (...args: unknown[]) => runCreating(proxy, target, method, args)
      if (IMPORTING.test(prop)) return (...args: unknown[]) => runImport(target, method, args)
      return value
    },
  })
  return proxy
}
