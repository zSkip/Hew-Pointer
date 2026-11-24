/**
 * The different-filament rules, enforced on the Scene (`withBuildFilament`,
 * filamentScene.ts) so every tool, panel and menu command gets them.
 *
 * An Object is printed in one filament. So:
 *
 * - A union, a Rejoin or a Link Similar whose Objects (counting every Object
 *   inside a group or component operand) are made of more than one filament
 *   is refused before the kernel is called, naming the filaments. Subtract and
 *   intersect are allowed and keep operand A's filament (the kernel's rule).
 * - An operation that would add material to an Object made of another
 *   filament than the selected one is refused, naming both: the selected
 *   filament is what new material is made of, and it cannot go into an Object
 *   of another. Push/Pull does not get here for a world face: it pulls a new
 *   Object out of such a face instead (tools/PushPullTool.ts). Operations
 *   that only remove material are unaffected.
 *
 * Whether an operation adds material is known from its arguments where it
 * can be (the sign of a push/pull distance or a Project depth; thickening a
 * sheet always does). A merged Follow Me (union or carve, the kernel decides)
 * and a blend (a fillet fills an inside corner, rounds off an outside one)
 * run first and are measured: when the Object's volume grew, the step is
 * undone without a trace and refused.
 *
 * Nothing applies while no filament is selected: Hew behaves as upstream.
 */

import { t } from '@lingui/core/macro'
import { historyLabel } from '../i18n/historyLabels'
import { parseHistoryEntries } from '../panels/changesModel'
import { inHistoryBracket } from '../tools/transformSelection'
import type { Scene as WasmScene } from '../wasm/loader'
import { selectedFilament } from './filaments'
import { differenceOn, filamentName, readObjectFilament, type FilamentDifference, type ObjectAt } from './objectFilament'

/** The error code of every refusal here. Its message is already written for
 *  people (kernelErrors.ts shows it as it is). */
// oxlint-disable-next-line lingui/no-unlocalized-strings -- an error code, not copy
export const FILAMENT_REFUSAL_CODE = 'FilamentMismatch'

/** A refusal: `"FilamentMismatch: <message>"`, like a kernel error. */
export function filamentRefusal(message: string): Error {
  return new Error(`${FILAMENT_REFUSAL_CODE}: ${message}`)
}

/** The newest undo entry's label, as the Edit menu would show it. */
export function topEntryLabel(scene: WasmScene): string | null {
  const entries = parseHistoryEntries(scene.history_entries_json())
  const top = entries.undo[entries.undo.length - 1]
  return top === undefined ? null : historyLabel(top.kind, top.label)
}

/** Runs a wrapped method: `run` is what the call does without the rules. */
export type FilamentGuard = (proxy: WasmScene, scene: WasmScene, args: unknown[], run: () => unknown) => unknown

// ── Mixing filaments ────────────────────────────────────────────────────────

const OP_UNION = 0
const KIND_GROUP = 1
const KIND_INSTANCE = 2

/** An Object, and the placement it is reached through when it is a member
 *  of a component or linked set. */
interface Leaf {
  object: bigint
  instance?: bigint
}

const leaf = (object: bigint): Leaf => ({ object })

/** Every Object a boolean operand stands for. */
function leavesOf(scene: WasmScene, kind: number, id: bigint): Leaf[] {
  try {
    if (kind === KIND_INSTANCE) return Array.from(scene.instance_expanded_members(id), (object) => ({ object, instance: id }))
    if (kind === KIND_GROUP) return Array.from(scene.node_leaf_objects(kind, id), leaf)
  } catch {
    // A stale operand: the kernel refuses it with its own error.
    return []
  }
  return [leaf(id)]
}

/** The distinct filament names of `leaves`, in first-seen order. */
function filamentNames(scene: WasmScene, leaves: readonly Leaf[]): string[] {
  const names: string[] = []
  for (const l of leaves) {
    const name = filamentName(readObjectFilament(scene, l.object, { instance: l.instance }))
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join('')
  const head = names.slice(0, -1).join(', ')
  const last = names[names.length - 1]
  return t`${head} and ${last}`
}

/** Refuse when `leaves` are made of more than one filament. */
function refuseMixed(scene: WasmScene, leaves: readonly Leaf[], kind: 'join' | 'link'): void {
  if (selectedFilament() === null) return
  const names = filamentNames(scene, leaves)
  if (names.length < 2) return
  const list = listOf(names)
  throw filamentRefusal(
    kind === 'link'
      ? t`These are made of ${list}, and linked copies share one filament. Give them the same filament first.`
      : t`These are made of ${list}, and an object is printed in one filament, so they can't become one object. Keep them separate, or give them the same filament first.`,
  )
}

function mixing(objects: (scene: WasmScene, args: unknown[]) => Leaf[] | null, kind: 'join' | 'link' = 'join'): FilamentGuard {
  return (_proxy, scene, args, run) => {
    const list = objects(scene, args)
    if (list !== null) refuseMixed(scene, list, kind)
    return run()
  }
}

const big = (v: unknown): bigint => BigInt(v as bigint | number)
const bigs = (v: unknown): bigint[] => Array.from(v as ArrayLike<bigint | number>, (x) => BigInt(x))

// ── Adding to another filament ──────────────────────────────────────────────

type Grow = 'pull' | 'thicken' | 'emboss' | 'merge' | 'blend'

function growthMessage(grow: Grow, d: FilamentDifference): string {
  const o = d.object
  const s = d.selected
  switch (grow) {
    case 'pull':
      return t`This face is ${o}, so it can't be pulled out in ${s} here. Push it in to cut, select ${o}, or pull it out outside the component to make a new ${s} object.`
    case 'thicken':
      return t`This sheet is ${o}, so thickening it would add ${s} to it. Select ${o} to thicken it.`
    case 'emboss':
      return t`This object is ${o}, so embossing would add ${s} to it. Engrave instead, or select ${o} to emboss.`
    case 'merge':
      return t`This sweep would add ${s} to an object made of ${o}. Sweep it as a separate object, or select ${o} to merge it.`
    case 'blend':
      return t`Rounding these edges would add ${s} to an object made of ${o}. Select ${o} to round them.`
  }
}

/** The Object a call may add to: a face of it when the call names one, and
 *  the placement it is edited through. */
interface Subject extends ObjectAt {
  object: bigint
}

/** A call that adds material whenever `adds` says so, read from its arguments. */
function adding(grow: Grow, subject: (args: unknown[]) => Subject | null, adds: (args: unknown[]) => boolean): FilamentGuard {
  return (_proxy, scene, args, run) => {
    const s = subject(args)
    if (s !== null && adds(args)) {
      const d = differenceOn(scene, s.object, s)
      if (d !== null) throw filamentRefusal(growthMessage(grow, d))
    }
    return run()
  }
}

/** Where a volume is measured: a world Object (0) or a placement (2). */
interface Place {
  kind: 0 | 2
  id: bigint
}

/** A node's volume in m³, or null when it cannot be measured (an open
 *  shape, or nothing placed in the world). */
function volumeOf(scene: WasmScene, place: Place): number | null {
  try {
    const v = (JSON.parse(scene.measure_json(place.kind, place.id)) as { volume?: unknown }).volume
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** How much a volume may grow from rounding alone before it counts as added
 *  material: relative to the volume, with a floor of a cubic micrometre. */
const VOLUME_GROWTH_RELATIVE = 1e-9
const VOLUME_GROWTH_FLOOR_M3 = 1e-18

/**
 * A call that may add or remove (the kernel decides): run it inside one
 * history bracket and measure; when the volume grew on an Object of another
 * filament, the bracket is aborted (the document is as it was) and the call
 * refused. `before` is where to measure first, `after` where the result is.
 */
function measured(
  grow: Grow,
  subject: (args: unknown[]) => Subject | null,
  before: (args: unknown[]) => Place,
  after: (args: unknown[], result: unknown) => Place,
): FilamentGuard {
  return (proxy, scene, args, run) => {
    const s = subject(args)
    const d = s === null ? null : differenceOn(scene, s.object, s)
    if (d === null) return run()
    const start = volumeOf(scene, before(args))
    if (start === null) return run()
    let label = ''
    return inHistoryBracket(
      proxy,
      () => label,
      () => {
        const result = run()
        label = topEntryLabel(scene) ?? ''
        const end = volumeOf(scene, after(args, result))
        if (end !== null && end - start > Math.max(Math.abs(start) * VOLUME_GROWTH_RELATIVE, VOLUME_GROWTH_FLOOR_M3)) {
          throw filamentRefusal(growthMessage(grow, d))
        }
        return result
      },
    )
  }
}

const world = (id: bigint): Place => ({ kind: 0, id })
const placement = (id: bigint): Place => ({ kind: 2, id })
/** The result handle of a call that returns one. */
const resultObject = (_args: unknown[], result: unknown): Place => world(big(result))

/** Follow Me with a solid face as the profile merges only when the profile
 *  face belongs to the path's own solid. `o` is the profile object's index;
 *  an `_in_instance` call has the placement first. */
const sameSolid = (o: number) => (args: unknown[]): Subject | null =>
  big(args[o]) === big(args[o + 2])
    ? { object: big(args[o]), face: big(args[o + 1]), ...(o > 0 ? { instance: big(args[0]) } : {}) }
    : null

/** Every wrapped method that the rules reach, by name. */
export const FILAMENT_GUARDS: Readonly<Record<string, FilamentGuard>> = {
  // Unions.
  boolean: mixing((_s, [op, a, b]) => (Number(op) === OP_UNION ? [leaf(big(a)), leaf(big(b))] : null)),
  boolean_nodes: mixing((s, [op, ak, a, bk, b]) =>
    Number(op) === OP_UNION ? [...leavesOf(s, Number(ak), big(a)), ...leavesOf(s, Number(bk), big(b))] : null,
  ),
  boolean_nodes_many: mixing((s, [op, kinds, ids]) => {
    if (Number(op) !== OP_UNION) return null
    const k = Array.from(kinds as ArrayLike<number>)
    return bigs(ids).flatMap((id, i) => leavesOf(s, k[i], id))
  }),
  boolean_in_component: mixing((_s, [, op, a, b]) => (Number(op) === OP_UNION ? [leaf(big(a)), leaf(big(b))] : null)),
  boolean_in_component_many: mixing((_s, [, op, ids]) => (Number(op) === OP_UNION ? bigs(ids).map(leaf) : null)),
  boolean_through_placement_json: mixing((s, [path, host, tool, op]) => {
    if (Number(op) !== OP_UNION) return null
    const chain = bigs(path)
    const placed = chain.length > 0 ? chain[chain.length - 1] : undefined
    const hosts = host !== undefined && host !== null ? [{ object: big(host), instance: placed }] : placed !== undefined ? leavesOf(s, KIND_INSTANCE, placed) : []
    return [...hosts, leaf(big(tool))]
  }),
  rejoin_as_one_solid: mixing((_s, [ids]) => bigs(ids).map(leaf)),
  // A joiner becomes a copy of the set, taking the set's filament.
  join_linked: mixing((s, [set, joiner]) => [...leavesOf(s, KIND_INSTANCE, big(set)), leaf(big(joiner))], 'link'),
  join_linked_report: mixing((s, [set, joiner]) => [...leavesOf(s, KIND_INSTANCE, big(set)), leaf(big(joiner))], 'link'),

  // Push/Pull out of a face (a world face is routed to a new Object first).
  push_pull: adding('pull', ([o, f]) => ({ object: big(o), face: big(f) }), ([, , d]) => Number(d) > 0),
  push_pull_in_component: adding('pull', ([i, o, f]) => ({ object: big(o), face: big(f), instance: big(i) }), ([, , , d]) => Number(d) > 0),
  // A sheet has no material to cut: thickening only adds.
  thicken_sheet: adding('thicken', ([o]) => ({ object: big(o) }), () => true),
  thicken_sheet_in_instance: adding('thicken', ([i, o]) => ({ object: big(o), instance: big(i) }), () => true),
  // Project: a positive depth engraves, a negative one embosses.
  project_depth: adding('emboss', ([o]) => ({ object: big(o) }), ([, , , depth]) => Number(depth) < 0),

  // Follow Me merged with the path's solid.
  follow_me_merged_around_face: measured('merge', ([, , o, f]) => ({ object: big(o), face: big(f) }), ([, , o]) => world(big(o)), resultObject),
  follow_me_merged_around_face_with: measured('merge', ([, , o, f]) => ({ object: big(o), face: big(f) }), ([, , o]) => world(big(o)), resultObject),
  follow_me_merged_around_face_in_instance: measured('merge', ([i, , , o, f]) => ({ object: big(o), face: big(f), instance: big(i) }), ([i]) => placement(big(i)), ([i]) => placement(big(i))),
  follow_me_merged_around_face_in_instance_with: measured('merge', ([i, , , o, f]) => ({ object: big(o), face: big(f), instance: big(i) }), ([i]) => placement(big(i)), ([i]) => placement(big(i))),
  follow_me_face_around_face: measured('merge', sameSolid(0), ([o]) => world(big(o)), resultObject),
  follow_me_face_around_face_with: measured('merge', sameSolid(0), ([o]) => world(big(o)), resultObject),
  follow_me_face_around_face_in_instance: measured('merge', sameSolid(1), ([i]) => placement(big(i)), ([i]) => placement(big(i))),
  follow_me_face_around_face_in_instance_with: measured('merge', sameSolid(1), ([i]) => placement(big(i)), ([i]) => placement(big(i))),

  // Blends: a fillet in an inside corner adds material.
  blend_edges: measured('blend', ([o]) => ({ object: big(o) }), ([o]) => world(big(o)), ([o]) => world(big(o))),
  resize_blend: measured('blend', ([o]) => ({ object: big(o) }), ([o]) => world(big(o)), ([o]) => world(big(o))),
  blend_edges_in_component: measured('blend', ([i, o]) => ({ object: big(o), instance: big(i) }), ([i]) => placement(big(i)), ([i]) => placement(big(i))),
  resize_blend_in_component: measured('blend', ([i, o]) => ({ object: big(o), instance: big(i) }), ([i]) => placement(big(i)), ([i]) => placement(big(i))),
}
