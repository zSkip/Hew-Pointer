/**
 * The filaments a user builds with, and which one is selected.
 *
 * Inside Borpa the host is the only source of the list: it sends the
 * filaments compatible with the selected printer through
 * `window.__borpaHew.setFilaments` (borpa/host.ts) when the page is ready and
 * again whenever the printer or filament presets change. Outside Borpa (the
 * plain web app, development and tests) a small built-in list of generic
 * types stands in, so the app still runs.
 *
 * The selection is a preset name. It survives a new list when that preset is
 * still in it; otherwise the first filament in a project slot (lowest slot)
 * is selected, or the first filament of the list.
 */

import { isBorpa } from './host'

/** One filament preset, as the host describes it. */
export interface Filament {
  /** The preset's name, unique within the list. */
  name: string
  /** `filament_type`: PLA, PETG, ABS… */
  type: string
  vendor: string
  /** `#RRGGBB` */
  colour: string
  /** g/cm³, or null when the preset gives none. */
  density: number | null
  /** `temperature_vitrification` in °C, or null. */
  softeningTemp: number | null
  /** The project's filament slot holding this preset (1-based), or null. */
  slot: number | null
}

/**
 * Outside Borpa: generic types with the density and softening temperature of
 * Orca's generic filament profiles (`OrcaFilamentLibrary/filament/base`). The
 * colours only tell the types apart on screen.
 */
/* oxlint-disable lingui/no-unlocalized-strings -- preset names, types and vendors are identifiers shared with the slicer, not copy */
export const GENERIC_FILAMENTS: readonly Filament[] = [
  { name: 'Generic PLA', type: 'PLA', vendor: 'Generic', colour: '#F2F2F2', density: 1.24, softeningTemp: 45, slot: null },
  { name: 'Generic PETG', type: 'PETG', vendor: 'Generic', colour: '#2E8BD8', density: 1.27, softeningTemp: 70, slot: null },
  { name: 'Generic ABS', type: 'ABS', vendor: 'Generic', colour: '#D8432E', density: 1.04, softeningTemp: 110, slot: null },
  { name: 'Generic ASA', type: 'ASA', vendor: 'Generic', colour: '#3A3A3A', density: 1.04, softeningTemp: 110, slot: null },
  { name: 'Generic TPU', type: 'TPU', vendor: 'Generic', colour: '#F2C12E', density: 1.24, softeningTemp: 30, slot: null },
  { name: 'Generic PA', type: 'PA', vendor: 'Generic', colour: '#8C74B5', density: 1.04, softeningTemp: 108, slot: null },
  { name: 'Generic PC', type: 'PC', vendor: 'Generic', colour: '#5FB56A', density: 1.04, softeningTemp: 120, slot: null },
]

/** Orca's own default filament colour, for an entry that gives none. */
const DEFAULT_COLOUR = '#F2754E'
/* oxlint-enable lingui/no-unlocalized-strings */

export interface FilamentState {
  filaments: readonly Filament[]
  /** The selected filament's preset name, or null when the list is empty. */
  selected: string | null
}

const HEX = /^#[0-9a-fA-F]{6}$/

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One host entry, or null when it is not a usable filament. */
function parseFilament(raw: unknown): Filament | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name.trim() === '') return null
  const slot = finiteOrNull(r.slot)
  return {
    name: r.name,
    type: typeof r.type === 'string' ? r.type : '',
    vendor: typeof r.vendor === 'string' ? r.vendor : '',
    colour: typeof r.colour === 'string' && HEX.test(r.colour) ? r.colour.toUpperCase() : DEFAULT_COLOUR,
    density: finiteOrNull(r.density),
    softeningTemp: finiteOrNull(r.softeningTemp),
    slot: slot !== null && slot >= 1 ? Math.floor(slot) : null,
  }
}

/** The host's list, cleaned: unusable entries and repeated names dropped. */
export function parseFilaments(raw: unknown): Filament[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Filament[] = []
  for (const entry of raw) {
    const f = parseFilament(entry)
    if (f === null || seen.has(f.name)) continue
    seen.add(f.name)
    out.push(f)
  }
  return out
}

/** The selection a new list keeps or falls back to. */
export function chooseSelection(filaments: readonly Filament[], previous: string | null): string | null {
  if (previous !== null && filaments.some((f) => f.name === previous)) return previous
  let best: Filament | null = null
  for (const f of filaments) {
    if (f.slot !== null && (best === null || (best.slot ?? Infinity) > f.slot)) best = f
  }
  return (best ?? filaments[0])?.name ?? null
}

let state: FilamentState = {
  filaments: isBorpa ? [] : GENERIC_FILAMENTS,
  selected: isBorpa ? null : chooseSelection(GENERIC_FILAMENTS, null),
}
const listeners = new Set<() => void>()

function publish(next: FilamentState): void {
  state = next
  for (const l of listeners) l()
}

export function getFilamentState(): FilamentState {
  return state
}

export function subscribeFilaments(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Replace the list (the host's `setFilaments`). */
export function setFilaments(raw: unknown): void {
  const filaments = parseFilaments(raw)
  publish({ filaments, selected: chooseSelection(filaments, state.selected) })
}

/** Select a filament by preset name; a name not in the list is ignored. */
export function selectFilament(name: string): void {
  if (name === state.selected || !state.filaments.some((f) => f.name === name)) return
  publish({ ...state, selected: name })
}

/** The selected filament, or null. */
export function selectedFilament(): Filament | null {
  return state.filaments.find((f) => f.name === state.selected) ?? null
}

// The host's entry point. Installed at load, ahead of the bridge's `ready`,
// so the list the host sends in answer always has somewhere to land.
if (isBorpa) window.__borpaHew = { ...window.__borpaHew, setFilaments }

/** Test seam: put the store back to a given state. */
export function resetFilamentsForTest(filaments: readonly Filament[], selected?: string | null): void {
  publish({ filaments, selected: selected === undefined ? chooseSelection(filaments, null) : selected })
}
