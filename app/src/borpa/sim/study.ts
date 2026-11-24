/**
 * Simulation studies, stored in the Hew document.
 *
 * A study belongs to one Object and lives on it as the attribute dictionary
 * `borpa.sim`, key `study` (version 1). The faces a fixture or force is on
 * are marked on the faces themselves: each picked face carries `borpa.sim`,
 * key `picks`, a list of pick keys, and each fixture or force lists the pick
 * keys it was given. Face dictionaries are saved with the geometry and move
 * with their face through edits (docs/agents/HEW_API.md §8): a face pushed or
 * pulled keeps its marks, both halves of a split face keep them, and a
 * reopened document still has them, which kernel face handles would not
 * survive. A pick key that no face carries any more is a face an edit
 * removed: the panel shows it as lost.
 *
 * Every change is one `hew.doc.transact`, so one undo step.
 */

import type { Scene as WasmScene } from '../../wasm/loader'
import { withApi, type Api } from '../buildMaterial'
import type { ObjectFaces } from './objectFaces'
import type { SimMaterial } from './placeholderMaterials'

export const SIM_NS = 'borpa.sim'
/* oxlint-disable lingui/no-unlocalized-strings -- attribute keys and study fields are identifiers */
const STUDY_KEY = 'study'
const PICKS_KEY = 'picks'

export type Vec3 = [number, number, number]

export interface StoredFixture {
  key: string
  picks: string[]
}

export interface StoredForce {
  key: string
  /** Total force on the faces, N, world axes. */
  vector: Vec3
  picks: string[]
}

/** A study as the document stores it. */
export interface StoredStudy {
  version: 1
  kind: 'static'
  /** Values the user typed; null: the filament's placeholder values. */
  material: { E: number; nu: number } | null
  fixtures: StoredFixture[]
  loads: StoredForce[]
  mesh: { size: number | null }
  /** The next number for a fixture, force or pick key. */
  next: number
}

export function emptyStudy(): StoredStudy {
  return { version: 1, kind: 'static', material: null, fixtures: [], loads: [], mesh: { size: null }, next: 1 }
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

function vec3(v: unknown): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return [0, 0, 0]
  return [v[0], v[1], v[2]]
}

/** A stored study read back, or null when the value is not a version 1 study.
 *  Unknown fields are dropped; malformed entries are repaired to empty ones. */
export function parseStoredStudy(raw: unknown): StoredStudy | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || r.kind !== 'static') return null
  const m = r.material as Record<string, unknown> | null | undefined
  const material = m !== null && typeof m === 'object' && finite(m.E) && finite(m.nu) ? { E: m.E, nu: m.nu } : null
  const items = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [])
  const fixtures = items(r.fixtures)
    .filter((f) => typeof f.key === 'string')
    .map((f) => ({ key: f.key as string, picks: strings(f.picks) }))
  const loads = items(r.loads)
    .filter((l) => typeof l.key === 'string')
    .map((l) => ({ key: l.key as string, vector: vec3(l.vector), picks: strings(l.picks) }))
  const mesh = r.mesh as Record<string, unknown> | undefined
  const size = mesh !== undefined && mesh !== null && finite(mesh.size) && mesh.size > 0 ? mesh.size : null
  const next = finite(r.next) && r.next >= 1 ? Math.floor(r.next) : 1
  return { version: 1, kind: 'static', material, fixtures, loads, mesh: { size }, next }
}

/** One fixture or force with its faces found. */
export interface ResolvedItem {
  key: string
  /** Face indices (into `ObjectFaces.faces`) carrying one of its picks. */
  faces: number[]
  /** Picks no face carries any more: faces an edit removed. */
  lost: number
}

export interface ResolvedStudy {
  stored: StoredStudy
  fixtures: ResolvedItem[]
  loads: (ResolvedItem & { vector: Vec3 })[]
  /** The pick keys each face carries. */
  facePicks: Map<number, string[]>
}

// ── Reading ─────────────────────────────────────────────────────────────────

function sendApi(api: Api, method: string, params: unknown): unknown {
  return api.send(method, params)
}

function objectPublicId(scene: Pick<WasmScene, 'object_public_ids'>, object: bigint): string {
  const id = scene.object_public_ids(BigUint64Array.from([object]))[0]
  if (!id) throw new Error('the Object has no id')
  return id
}

function faceTarget(objectId: string, of: ObjectFaces, face: number): unknown {
  return { face: { object: objectId, at: of.faces[face].anchor } }
}

function nsDict(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const d = (raw as Record<string, unknown>)[SIM_NS]
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : null
}

/** The stored study on an Object, or null when it has none. */
export function readStoredStudy(scene: WasmScene, object: bigint): StoredStudy | null {
  return withApi(scene, (api) => {
    const dict = nsDict(sendApi(api, 'hew.attr.get', { target: objectPublicId(scene, object), ns: SIM_NS }))
    return dict === null ? null : parseStoredStudy(dict[STUDY_KEY])
  })
}

/** The pick keys each face of the Object carries. Faces are read one by one,
 *  and only when the Object's face query shows any face with marks. */
export function readFacePicks(scene: WasmScene, of: ObjectFaces): Map<number, string[]> {
  return withApi(scene, (api) => {
    const objectId = objectPublicId(scene, of.object)
    const out = new Map<number, string[]>()
    const listed = sendApi(api, 'hew.query.faces', { object: objectId }) as { faces?: { attrs?: unknown }[] }
    if (!(listed.faces ?? []).some((f) => nsDict(f.attrs) !== null)) return out
    of.faces.forEach((_, i) => {
      try {
        const dict = nsDict(sendApi(api, 'hew.attr.get', { target: faceTarget(objectId, of, i), ns: SIM_NS }))
        const picks = dict === null ? [] : strings(dict[PICKS_KEY])
        if (picks.length > 0) out.set(i, picks)
      } catch {
        // A face the locator cannot name carries nothing the study can use.
      }
    })
    return out
  })
}

/** A stored study with its faces found. */
export function resolveStudy(stored: StoredStudy, facePicks: Map<number, string[]>): ResolvedStudy {
  const carriers = new Map<string, number[]>()
  for (const [face, picks] of facePicks) {
    for (const p of picks) {
      const list = carriers.get(p) ?? []
      list.push(face)
      carriers.set(p, list)
    }
  }
  const resolve = (item: { key: string; picks: string[] }): ResolvedItem => {
    const faces = new Set<number>()
    let lost = 0
    for (const p of item.picks) {
      const c = carriers.get(p)
      if (c === undefined) lost++
      else for (const f of c) faces.add(f)
    }
    return { key: item.key, faces: [...faces].sort((a, b) => a - b), lost }
  }
  return {
    stored,
    fixtures: stored.fixtures.map(resolve),
    loads: stored.loads.map((l) => ({ ...resolve(l), vector: l.vector })),
    facePicks,
  }
}

/** Read and resolve an Object's study; null when it has none. */
export function readStudy(scene: WasmScene, of: ObjectFaces): ResolvedStudy | null {
  const stored = readStoredStudy(scene, of.object)
  if (stored === null) return null
  return resolveStudy(stored, readFacePicks(scene, of))
}

// ── Writing ─────────────────────────────────────────────────────────────────

interface Command {
  method: string
  params: Record<string, unknown>
}

function transact(scene: WasmScene, label: string, commands: Command[]): void {
  if (commands.length === 0) return
  withApi(scene, (api) => sendApi(api, 'hew.doc.transact', { label, commands }))
}

function setStudyCommand(objectId: string, study: StoredStudy): Command {
  return { method: 'hew.attr.set', params: { target: objectId, ns: SIM_NS, key: STUDY_KEY, value: study } }
}

function setFacePicksCommand(objectId: string, of: ObjectFaces, face: number, picks: string[]): Command {
  return picks.length === 0
    ? { method: 'hew.attr.delete', params: { target: faceTarget(objectId, of, face), ns: SIM_NS, key: PICKS_KEY } }
    : { method: 'hew.attr.set', params: { target: faceTarget(objectId, of, face), ns: SIM_NS, key: PICKS_KEY, value: picks } }
}

/** Write a changed study (no face changes) as one undo step. */
export function writeStudy(scene: WasmScene, object: bigint, study: StoredStudy, label: string): void {
  transact(scene, label, [setStudyCommand(objectPublicId(scene, object), study)])
}

/** Add a fixture or a force; returns its key. */
export function addItem(scene: WasmScene, object: bigint, current: StoredStudy | null, kind: 'fixture' | 'force', label: string): string {
  const study = structuredClone(current ?? emptyStudy())
  const key = `${kind === 'fixture' ? 'f' : 'l'}${study.next}`
  study.next += 1
  if (kind === 'fixture') study.fixtures.push({ key, picks: [] })
  else study.loads.push({ key, vector: [0, 0, -10], picks: [] })
  writeStudy(scene, object, study, label)
  return key
}

function itemOf(study: StoredStudy, key: string): { key: string; picks: string[] } | undefined {
  return study.fixtures.find((f) => f.key === key) ?? study.loads.find((l) => l.key === key)
}

/**
 * Put `face` in the fixture or force `key`, or take it out when it is in it
 * already. One undo step: the face's marks and the study change together.
 */
export function toggleFace(scene: WasmScene, of: ObjectFaces, resolved: ResolvedStudy, key: string, face: number, label: string): void {
  const study = structuredClone(resolved.stored)
  const item = itemOf(study, key)
  if (item === undefined) return
  const objectId = objectPublicId(scene, of.object)
  const onFace = resolved.facePicks.get(face) ?? []
  const mine = onFace.filter((p) => item.picks.includes(p))
  const commands: Command[] = []
  if (mine.length > 0) {
    // Take it out: drop this item's picks from the face, and from the item
    // when no other face carries them (both halves of a split face do).
    commands.push(setFacePicksCommand(objectId, of, face, onFace.filter((p) => !mine.includes(p))))
    const elsewhere = new Set<string>()
    for (const [f, picks] of resolved.facePicks) if (f !== face) for (const p of picks) elsewhere.add(p)
    item.picks = item.picks.filter((p) => !mine.includes(p) || elsewhere.has(p))
  } else {
    const pick = `p${study.next}`
    study.next += 1
    commands.push(setFacePicksCommand(objectId, of, face, [...onFace, pick]))
    item.picks.push(pick)
  }
  commands.push(setStudyCommand(objectId, study))
  transact(scene, label, commands)
}

/** Remove a fixture or force and its marks on the faces. */
export function removeItem(scene: WasmScene, of: ObjectFaces, resolved: ResolvedStudy, key: string, label: string): void {
  const study = structuredClone(resolved.stored)
  const item = itemOf(study, key)
  if (item === undefined) return
  const objectId = objectPublicId(scene, of.object)
  const commands: Command[] = []
  for (const [face, picks] of resolved.facePicks) {
    const kept = picks.filter((p) => !item.picks.includes(p))
    if (kept.length !== picks.length) commands.push(setFacePicksCommand(objectId, of, face, kept))
  }
  study.fixtures = study.fixtures.filter((f) => f.key !== key)
  study.loads = study.loads.filter((l) => l.key !== key)
  commands.push(setStudyCommand(objectId, study))
  transact(scene, label, commands)
}

/** Forget picks no face carries any more (the "lost" faces of an item). */
export function dropLostPicks(scene: WasmScene, resolved: ResolvedStudy, object: bigint, key: string, label: string): void {
  const study = structuredClone(resolved.stored)
  const item = itemOf(study, key)
  if (item === undefined) return
  const carried = new Set<string>()
  for (const picks of resolved.facePicks.values()) for (const p of picks) carried.add(p)
  item.picks = item.picks.filter((p) => carried.has(p))
  writeStudy(scene, object, study, label)
}

// ── The request ─────────────────────────────────────────────────────────────

/** What is wrong with a study before it can run, or null. Codes, for the
 *  panel's wording. */
export type StudyProblem = 'no-fixture' | 'no-force' | 'empty-fixture' | 'empty-force' | 'zero-force' | 'bad-material'

export function studyProblem(resolved: ResolvedStudy, material: SimMaterial): StudyProblem | null {
  if (!(material.E > 0) || !(material.nu >= 0 && material.nu < 0.5)) return 'bad-material'
  if (resolved.fixtures.length === 0) return 'no-fixture'
  if (resolved.fixtures.some((f) => f.faces.length === 0)) return 'empty-fixture'
  if (resolved.loads.length === 0) return 'no-force'
  if (resolved.loads.some((l) => l.faces.length === 0)) return 'empty-force'
  if (resolved.loads.every((l) => l.vector.every((v) => v === 0))) return 'zero-force'
  return null
}

/** The `study` of a `sim.run` (version 1; docs/HLSD/hew-tab.md). Face numbers
 *  index the geometry's face list, which is `ObjectFaces.faces` in order. */
export function requestStudy(objectId: string, resolved: ResolvedStudy, material: SimMaterial): unknown {
  return {
    version: 1,
    kind: 'static',
    object: objectId,
    material: { name: material.name, E: material.E, nu: material.nu, density: material.density },
    fixtures: resolved.fixtures.map((f) => ({ faces: f.faces })),
    loads: resolved.loads.map((l) => ({ type: 'force', faces: l.faces, vector: l.vector })),
    mesh: { size: resolved.stored.mesh.size, refine: [] },
  }
}
/* oxlint-enable lingui/no-unlocalized-strings */

