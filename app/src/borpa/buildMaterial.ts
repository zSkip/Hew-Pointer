/**
 * Build materials: a Hew Material that stands for one filament preset.
 *
 * The material's name is the preset's name and its colour the preset's
 * colour. The link to the preset is an attribute dictionary on the material,
 * namespace `borpa.filament`, keys `preset`, `type` and `vendor`. An Object's
 * filament is its base material, and an Object has exactly one: per-face paint
 * is cleared wherever a filament is given.
 *
 * Everything here goes through the Hew API bus (`Scene.api_dispatch`):
 * attribute dictionaries are reached only there, and one `hew.doc.transact`
 * makes the material, links it and assigns it as one undo entry, or, inside
 * an open history bracket (`inHistoryBracket`), as part of the bracket's.
 */

import { parseDispatch } from '../api/dispatchResult'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Filament } from './filaments'

export const FILAMENT_NS = 'borpa.filament'

/** What the `borpa.filament` dictionary on a material holds. */
export interface FilamentLink {
  preset: string
  type: string
  vendor: string
}

type ApiScene = Pick<
  WasmScene,
  'api_connection_open' | 'api_connection_close' | 'api_dispatch' | 'material_ids' | 'material_info' | 'object_materials' | 'object_public_ids'
>

/* oxlint-disable lingui/no-unlocalized-strings -- FilamentApiError messages go to the diagnostic log, English for the maintainer */

/** A refused or failed API frame. */
export class FilamentApiError extends Error {
  constructor(
    message: string,
    readonly failedIndex: number | null = null,
  ) {
    super(message)
  }
}

let frameId = 0

/** One API connection, attached to the open document. */
class Api {
  private readonly conn: number

  constructor(private readonly scene: ApiScene) {
    this.conn = scene.api_connection_open()
    try {
      this.send('hew.meta.hello', { protocol: 1 })
      this.send('hew.doc.attach', {})
    } catch (err) {
      scene.api_connection_close(this.conn)
      throw err
    }
  }

  send(method: string, params: unknown): unknown {
    const d = parseDispatch(this.scene.api_dispatch(this.conn, JSON.stringify({ jsonrpc: '2.0', id: ++frameId, method, params })))
    // First-party commands only, which answer at once and never forward.
    if (d.kind !== 'reply') throw new FilamentApiError(`${method} gave no reply`)
    const reply = JSON.parse(d.frame) as {
      result?: unknown
      error?: { message?: string; data?: { failed_index?: number; explanation?: string } }
    }
    if (reply.error !== undefined) {
      const data = reply.error.data
      throw new FilamentApiError(data?.explanation ?? reply.error.message ?? `${method} failed`, data?.failed_index ?? null)
    }
    return reply.result
  }

  close(): void {
    this.scene.api_connection_close(this.conn)
  }
}

function withApi<T>(scene: ApiScene, body: (api: Api) => T): T {
  const api = new Api(scene)
  try {
    return body(api)
  } finally {
    api.close()
  }
}

/** `#RRGGBB` → `[r, g, b, 255]`. */
export function colourChannels(hex: string): [number, number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255]
}

/** A dictionary as `hew.attr.get` returns it, read as a link (or null). */
function parseLink(raw: unknown): FilamentLink | null {
  if (typeof raw !== 'object' || raw === null) return null
  const dict = (raw as Record<string, unknown>)[FILAMENT_NS]
  if (typeof dict !== 'object' || dict === null) return null
  const d = dict as Record<string, unknown>
  if (typeof d.preset !== 'string') return null
  return {
    preset: d.preset,
    type: typeof d.type === 'string' ? d.type : '',
    vendor: typeof d.vendor === 'string' ? d.vendor : '',
  }
}

/** The palette as the API names it: handle → public id. */
function materialPublicIds(api: Api, scene: ApiScene): Map<bigint, string> {
  const handles = scene.material_ids()
  const listed = (api.send('hew.query.scene', {}) as { materials?: { id?: unknown; name?: unknown }[] }).materials ?? []
  // Both list the kernel's palette in its own order.
  if (listed.length !== handles.length) throw new FilamentApiError('the palette and the API disagree')
  const out = new Map<bigint, string>()
  handles.forEach((h, i) => {
    const entry = listed[i]
    if (typeof entry.id !== 'string' || entry.name !== scene.material_info(h)?.name()) {
      throw new FilamentApiError('the palette and the API disagree')
    }
    out.set(h, entry.id)
  })
  return out
}

/** Every palette material with its public id and, when it has one, its filament link. */
interface PaletteEntry {
  handle: bigint
  id: string
  link: FilamentLink | null
}

function readPalette(api: Api, scene: ApiScene): PaletteEntry[] {
  return [...materialPublicIds(api, scene)].map(([handle, id]) => ({
    handle,
    id,
    link: parseLink(api.send('hew.attr.get', { target: id, ns: FILAMENT_NS })),
  }))
}

/** The filament links of every palette material that has one. */
export function readFilamentLinks(scene: ApiScene): Map<bigint, FilamentLink> {
  return withApi(scene, (api) => {
    const out = new Map<bigint, FilamentLink>()
    for (const e of readPalette(api, scene)) if (e.link !== null) out.set(e.handle, e.link)
    return out
  })
}

/** The filament of `list` a link stands for: by preset name, else by type. */
export function filamentForLink(link: FilamentLink, list: readonly Filament[]): Filament | null {
  return list.find((f) => f.name === link.preset) ?? list.find((f) => f.type !== '' && f.type === link.type) ?? null
}

interface Command {
  method: string
  as?: string
  params: Record<string, unknown>
}

const MATERIAL_REF = 'filament'

/**
 * How to name `filament`'s material inside a transaction: an existing linked
 * material, else a material of that name left without its link (an undo
 * removes the link the step wrote, not the palette entry) and unused, else a
 * new one. `setup` makes or re-links it; `ref` names it in later commands.
 */
function materialFor(palette: readonly PaletteEntry[], scene: ApiScene, filament: Filament): { setup: Command[]; ref: unknown; handle: bigint | null } {
  const linked = palette.find((e) => e.link?.preset === filament.name)
  if (linked !== undefined) return { setup: [], ref: linked.id, handle: linked.handle }
  const linkCommands = (target: unknown): Command[] =>
    (['preset', 'type', 'vendor'] as const).map((key) => ({
      method: 'hew.attr.set',
      params: { target, ns: FILAMENT_NS, key, value: key === 'preset' ? filament.name : filament[key] },
    }))
  const orphan = palette.find((e) => e.link === null && scene.material_info(e.handle)?.name() === filament.name && sceneUsage(scene, e.handle) === 0)
  if (orphan !== undefined) return { setup: linkCommands(orphan.id), ref: orphan.id, handle: orphan.handle }
  const ref = { $ref: `${MATERIAL_REF}#/material` }
  return {
    setup: [{ method: 'hew.material.create', as: MATERIAL_REF, params: { name: filament.name, color: colourChannels(filament.colour) } }, ...linkCommands(ref)],
    ref,
    handle: null,
  }
}

function sceneUsage(scene: ApiScene, handle: bigint): number {
  const s = scene as Partial<Pick<WasmScene, 'material_usage'>>
  return typeof s.material_usage === 'function' ? s.material_usage(handle) : 0
}

/** Which Objects take the filament. */
export type AssignMode =
  /** Every Object given: an import, a document opened from before filaments,
   *  or the user choosing a filament for the selection. */
  | 'all'
  /** Only Objects with no base material yet: what a modelling operation just
   *  created. A piece split off an Object keeps that Object's filament. */
  | 'unassigned'
  /** Only Objects whose base material is not a filament, or that carry
   *  per-face paint: a document opened from before filaments. */
  | 'unlinked'

export interface AssignResult {
  /** The Objects that changed. */
  assigned: bigint[]
  /** The filament's material, or null when nothing needed it. */
  material: bigint | null
}

/**
 * Give `objects` the filament `filament` as their only material: per-face
 * paint cleared, the filament's material as the base. Makes and links the
 * material the first time it is used. Locked Objects are left alone. One
 * `hew.doc.transact` labeled `label`; nothing changes when it refuses.
 */
export function assignFilament(scene: ApiScene, filament: Filament, objects: readonly bigint[], mode: AssignMode, label: string): AssignResult {
  if (objects.length === 0) return { assigned: [], material: null }
  return withApi(scene, (api) => {
    const palette = readPalette(api, scene)
    const byId = new Map(palette.map((e) => [e.id, e]))
    const publicIds = scene.object_public_ids(BigUint64Array.from(objects))
    const material = materialFor(palette, scene, filament)
    const commands: Command[] = []
    const assigned: bigint[] = []
    objects.forEach((object, i) => {
      const id = publicIds[i]
      if (!id) return
      const info = api.send('hew.query.entity', { id }) as { material_default?: unknown; locked?: unknown }
      if (info.locked === true) return
      const base = typeof info.material_default === 'string' ? byId.get(info.material_default) ?? null : null
      const all = scene.object_materials(object)
      const painted = all.filter((m) => m !== base?.handle)
      const isFilament = base !== null && base.link !== null
      if (mode === 'unassigned' && info.material_default !== null && info.material_default !== undefined) return
      if (mode === 'unlinked' && isFilament && painted.length === 0) return
      // Already this filament and unpainted: nothing to do.
      if (base !== null && material.handle !== null && base.handle === material.handle && painted.length === 0) return
      for (const m of painted) {
        const from = palette.find((e) => e.handle === m)?.id
        if (from !== undefined) commands.push({ method: 'hew.material.replace', params: { from, to: null, object: id } })
      }
      commands.push({ method: 'hew.material.set_default', params: { id, material: material.ref } })
      assigned.push(object)
    })
    if (assigned.length === 0) return { assigned, material: material.handle }
    const before = new Set(scene.material_ids())
    api.send('hew.doc.transact', { label, commands: [...material.setup, ...commands] })
    const handle = material.handle ?? scene.material_ids().find((h) => !before.has(h)) ?? null
    return { assigned, material: handle }
  })
}

/**
 * The material standing for `filament`, made and linked when there is none
 * yet (an undoable step labeled `label` when a link is written). Returns its
 * handle.
 */
export function ensureFilamentMaterial(scene: ApiScene, filament: Filament, label: string): bigint {
  return withApi(scene, (api) => {
    const material = materialFor(readPalette(api, scene), scene, filament)
    if (material.handle !== null && material.setup.length === 0) return material.handle
    const before = new Set(scene.material_ids())
    api.send('hew.doc.transact', { label, commands: material.setup })
    const handle = material.handle ?? scene.material_ids().find((h) => !before.has(h))
    if (handle === undefined) throw new FilamentApiError('the filament material was not made')
    return handle
  })
}
/* oxlint-enable lingui/no-unlocalized-strings */
