/**
 * Which filament an Object is made of, and whether that is the selected one.
 *
 * An Object's filament is its base material (`material_default`) when that
 * material is linked to a filament preset (buildMaterial.ts). "Different"
 * means the link names another preset than the selected filament's, or there
 * is no link at all (an Object made before filaments, or by a plugin).
 *
 * The rules that follow from it (Push/Pull pulls a new Object out of a
 * different filament's face; operations that would add material to such an
 * Object, and unions across filaments, are refused) apply only to a Scene
 * wrapped by `withBuildFilament` (filamentScene.ts), which registers itself
 * here, and only while a filament is selected. A bare Scene (Hew's own tests,
 * a tool driven without the wrapper) and an empty filament list behave as
 * upstream Hew.
 *
 * Push/Pull asks on every hover, so the answer is cached per document state:
 * palette handle → filament link, and Object → base material, both dropped
 * when the document epoch or its history generation moves (every recorded
 * edit, undo and redo moves the generation). The selection is not part of
 * the cache: comparing against it costs nothing. A face given with the
 * Object reads the base through `face_material` with no API call; an Object
 * alone reads it through one API query, cached the same way. The cache is
 * only read outside history brackets, where an aborted bracket cannot rewind
 * the generation to a value seen with other content.
 */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { Scene as WasmScene } from '../wasm/loader'
import { readBaseMaterials, readFilamentLinks, type FilamentLink } from './buildMaterial'
import { selectedFilament } from './filaments'

/** What this module reads of the Scene. */
export type FilamentReadScene = Pick<
  WasmScene,
  | 'api_connection_open'
  | 'api_connection_close'
  | 'api_dispatch'
  | 'material_ids'
  | 'material_info'
  | 'object_materials'
  | 'object_public_ids'
  | 'face_material'
  | 'instance_material'
  | 'history_generation'
  | 'document_epoch'
>

/** The material sentinel: no material. */
const NO_MATERIAL = 0xffff_ffff_ffff_ffffn

interface Snapshot {
  epoch: bigint
  generation: bigint
  links: Map<bigint, FilamentLink> | null
  bases: Map<bigint, bigint | null>
}

const snapshots = new WeakMap<object, Snapshot>()

/** Wrapped Scenes (withBuildFilament) → the Scene they wrap. */
const filamentScenes = new WeakMap<object, FilamentReadScene>()

/** Mark `wrapper` as a Scene that builds in filaments; reads go to `scene`. */
export function registerFilamentScene(wrapper: object, scene: FilamentReadScene): void {
  filamentScenes.set(wrapper, scene)
}

/** The Scene to read through when `scene` builds in filaments, else null. */
function filamentSceneOf(scene: object): FilamentReadScene | null {
  return filamentScenes.get(scene) ?? null
}

function snapshot(scene: FilamentReadScene): Snapshot {
  const epoch = BigInt(scene.document_epoch())
  const generation = BigInt(scene.history_generation())
  const held = snapshots.get(scene)
  if (held !== undefined && held.epoch === epoch && held.generation === generation) return held
  const fresh: Snapshot = { epoch, generation, links: null, bases: new Map() }
  snapshots.set(scene, fresh)
  return fresh
}

function links(scene: FilamentReadScene, s: Snapshot): Map<bigint, FilamentLink> {
  if (s.links === null) {
    try {
      s.links = readFilamentLinks(scene)
    } catch (err) {
      console.error('Borpa: could not read the filament links', err)
      s.links = new Map()
    }
  }
  return s.links
}

function baseMaterial(scene: FilamentReadScene, s: Snapshot, object: bigint, face: bigint | undefined): bigint | null {
  const held = s.bases.get(object)
  if (held !== undefined) return held
  let base: bigint | null = null
  if (face !== undefined) {
    const pair = scene.face_material(object, face)
    if (pair !== undefined) {
      try {
        const m = pair.object_default()
        base = m === NO_MATERIAL ? null : m
      } finally {
        pair.free()
      }
    }
  } else {
    try {
      base = readBaseMaterials(scene, [object]).get(object) ?? null
    } catch (err) {
      console.error('Borpa: could not read an Object\'s filament', err)
    }
  }
  s.bases.set(object, base)
  return base
}

/** Where an Object is being read: a face of it (any face, to make the read
 *  cheaper) and the placement it was reached through, if any. */
export interface ObjectAt {
  face?: bigint
  /** A component or linked-copy placement whose definition holds the
   *  Object. A linked set keeps its shared solid's material on the
   *  placement (`wrap_linked` moves the base there), so an Object with no
   *  base of its own takes the placement's. */
  instance?: bigint | null
}

/** The filament link of `object`'s base material (or, with none, of the
 *  placement's own material), or null when it has neither or that is not a
 *  filament. Read on `scene` itself, wrapped or not. */
export function readObjectFilament(scene: FilamentReadScene, object: bigint, at: ObjectAt = {}): FilamentLink | null {
  const s = snapshot(scene)
  let material = baseMaterial(scene, s, object, at.face)
  if (material === null && at.instance !== undefined && at.instance !== null) {
    const own = scene.instance_material(at.instance)
    if (own !== NO_MATERIAL) material = own
  }
  return material === null ? null : links(scene, s).get(material) ?? null
}

/** The names a message gives two filaments that differ. */
export interface FilamentDifference {
  /** The Object's filament, as the Filaments pane names it. */
  object: string
  /** The selected filament. */
  selected: string
}

const NO_FILAMENT = msg`no filament`

/** A link's name as the Filaments pane shows it: the preset name. */
export function filamentName(link: FilamentLink | null): string {
  return link === null ? i18n._(NO_FILAMENT) : link.preset
}

/** How `object` differs from the selected filament, read on the unwrapped
 *  `scene`; null when it does not, or no filament is selected. */
export function differenceOn(scene: FilamentReadScene, object: bigint, at: ObjectAt = {}): FilamentDifference | null {
  const selected = selectedFilament()
  if (selected === null) return null
  const link = readObjectFilament(scene, object, at)
  if (link !== null && link.preset === selected.name) return null
  return { object: filamentName(link), selected: selected.name }
}

/**
 * How `object` differs from the selected filament, or null when it is made
 * of the selected filament, no filament is selected, or `scene` does not
 * build in filaments (it was not wrapped by `withBuildFilament`).
 */
export function filamentDifference(scene: object, object: bigint, at: ObjectAt = {}): FilamentDifference | null {
  const inner = filamentSceneOf(scene)
  return inner === null ? null : differenceOn(inner, object, at)
}

/** Whether `object` is made of another filament than the selected one
 *  (`filamentDifference` is not null). */
export function differsFromSelected(scene: object, object: bigint, at: ObjectAt = {}): boolean {
  return filamentDifference(scene, object, at) !== null
}

/** Test seam: forget every cached answer. */
export function clearFilamentCacheForTest(scene: object): void {
  snapshots.delete(filamentSceneOf(scene) ?? scene)
}
