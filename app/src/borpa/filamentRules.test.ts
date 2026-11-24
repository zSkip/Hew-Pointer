/**
 * The guards of filamentRules.ts that are costly to reach with real geometry
 * (merged Follow Me, thickening a sheet, Rejoin, the in-component variants):
 * which arguments name the Object and placement, when the call is let through,
 * and that a grown volume is refused with the bracket aborted. The filament
 * read itself is stubbed: Object 1 is PETG, everything else PLA, PLA selected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scene as WasmScene } from '../wasm/loader'
import type { FilamentLink } from './buildMaterial'
import { FILAMENT_GUARDS, FILAMENT_REFUSAL_CODE } from './filamentRules'
import { GENERIC_FILAMENTS, resetFilamentsForTest } from './filaments'
import type { ObjectAt } from './objectFilament'

const PETG_OBJECT = 1n
const MEMBER = 5n
const PLACEMENT = 9n
const link = (preset: string): FilamentLink => ({ preset, type: '', vendor: '' })

const reads: Array<{ object: bigint; at: ObjectAt }> = []

vi.mock('./objectFilament', async (importOriginal) => {
  const real = await importOriginal<typeof import('./objectFilament')>()
  /** Object 1 is PETG; a member reached through placement 9 is PETG too
   *  (its filament is the placement's); anything else is PLA. */
  const readObjectFilament = (_s: unknown, object: bigint, at: ObjectAt = {}): FilamentLink => {
    reads.push({ object, at })
    return object === PETG_OBJECT || (object === MEMBER && at.instance === PLACEMENT) ? link('Generic PETG') : link('Generic PLA')
  }
  return {
    ...real,
    readObjectFilament,
    differenceOn: (s: unknown, object: bigint, at: ObjectAt = {}) => {
      const name = readObjectFilament(s, object, at).preset
      return name === 'Generic PLA' ? null : { object: name, selected: 'Generic PLA' }
    },
  }
})

/** A Scene stub: volumes by node, a history bracket that records its fate. */
function stubScene(volumes: Map<string, number>) {
  const bracket: string[] = []
  const scene = {
    measure_json: (kind: number, id: bigint) => {
      const v = volumes.get(`${kind}:${id}`)
      if (v === undefined) throw new Error('NotPlaced: no world placement')
      return JSON.stringify({ volume: v })
    },
    history_entries_json: () => JSON.stringify({ undo: [{ label: 'Follow Me' }], redo: [] }),
    history_bracket_open: () => bracket.push('open'),
    history_bracket_commit: () => bracket.push('commit'),
    history_bracket_abort: () => bracket.push('abort'),
    instance_expanded_members: () => BigUint64Array.of(MEMBER),
    node_leaf_objects: () => BigUint64Array.of(PETG_OBJECT, 2n),
  }
  return { scene: scene as unknown as WasmScene, bracket }
}

function call(name: string, scene: WasmScene, args: unknown[], run: () => unknown = () => 'ran'): unknown {
  const guard = FILAMENT_GUARDS[name]
  expect(guard).toBeDefined()
  return guard(scene, scene, args, run)
}

function refusal(f: () => unknown): string {
  try {
    f()
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    expect(text.startsWith(`${FILAMENT_REFUSAL_CODE}: `)).toBe(true)
    return text
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  reads.length = 0
  resetFilamentsForTest(GENERIC_FILAMENTS, 'Generic PLA')
})
afterEach(() => resetFilamentsForTest(GENERIC_FILAMENTS))

describe('merged Follow Me', () => {
  it('refuses a merge that grew a PETG Object, aborting its step; lets a carve through', () => {
    const volumes = new Map([['0:1', 1]])
    const { scene, bracket } = stubScene(volumes)
    // The merge returns the new solid 7, bigger than the base: refused.
    volumes.set('0:7', 1.2)
    const text = refusal(() => call('follow_me_merged_around_face', scene, [3n, 4n, PETG_OBJECT, 11n, undefined], () => 7n))
    expect(text).toContain('Generic PETG')
    expect(text).toContain('Generic PLA')
    expect(bracket).toEqual(['open', 'abort'])

    // A carve: smaller, committed as one step.
    bracket.length = 0
    volumes.set('0:7', 0.8)
    expect(call('follow_me_merged_around_face_with', scene, [3n, 4n, PETG_OBJECT, 11n, undefined, 0, 1, 0], () => 7n)).toBe(7n)
    expect(bracket).toEqual(['open', 'commit'])
  })

  it('lets a merge onto an Object of the selected filament through unmeasured', () => {
    const { scene, bracket } = stubScene(new Map())
    expect(call('follow_me_merged_around_face', scene, [3n, 4n, 2n, 11n, undefined])).toBe('ran')
    expect(bracket).toEqual([])
  })

  it('measures the placement inside a component, reading the member through it', () => {
    const volumes = new Map([['2:9', 1]])
    const { scene, bracket } = stubScene(volumes)
    refusal(() =>
      call('follow_me_merged_around_face_in_instance', scene, [PLACEMENT, 3n, 4n, MEMBER, 11n, undefined], () => {
        volumes.set('2:9', 1.5)
        return 7n
      }),
    )
    expect(reads.some((r) => r.object === MEMBER && r.at.instance === PLACEMENT)).toBe(true)
    expect(bracket).toEqual(['open', 'abort'])
  })

  it('a face profile merges only with its own solid: another solid is a new Object, let through', () => {
    const { scene } = stubScene(new Map([['0:1', 1]]))
    expect(call('follow_me_face_around_face', scene, [2n, 21n, PETG_OBJECT, 11n, undefined])).toBe('ran')
    const volumes = new Map([['0:1', 1], ['0:7', 2]])
    const own = stubScene(volumes)
    refusal(() => call('follow_me_face_around_face', own.scene, [PETG_OBJECT, 21n, PETG_OBJECT, 11n, undefined], () => 7n))
  })

  it('lets a call through when the volume cannot be measured', () => {
    const { scene, bracket } = stubScene(new Map())
    expect(call('follow_me_merged_around_face', scene, [3n, 4n, PETG_OBJECT, 11n, undefined])).toBe('ran')
    expect(bracket).toEqual([])
  })
})

describe('adding to another filament, read from the arguments', () => {
  it('thicken_sheet: refused on a PETG sheet, allowed on a PLA one', () => {
    const { scene } = stubScene(new Map())
    refusal(() => call('thicken_sheet', scene, [PETG_OBJECT, 0, 0.1]))
    expect(call('thicken_sheet', scene, [2n, 0, 0.1])).toBe('ran')
    refusal(() => call('thicken_sheet_in_instance', scene, [PLACEMENT, MEMBER, 0.1]))
    expect(call('thicken_sheet_in_instance', scene, [3n, MEMBER, 0.1])).toBe('ran')
  })

  it('push_pull_in_component: only a pull out of a PETG member is refused', () => {
    const { scene } = stubScene(new Map())
    refusal(() => call('push_pull_in_component', scene, [PLACEMENT, MEMBER, 11n, 0.1]))
    expect(call('push_pull_in_component', scene, [PLACEMENT, MEMBER, 11n, -0.1])).toBe('ran')
    expect(call('push_pull_in_component', scene, [3n, MEMBER, 11n, 0.1])).toBe('ran')
  })

  it('blend inside a component measures the placement', () => {
    const volumes = new Map([['2:9', 1]])
    const { scene } = stubScene(volumes)
    refusal(() =>
      call('blend_edges_in_component', scene, [PLACEMENT, MEMBER, '{}'], () => {
        volumes.set('2:9', 1.01)
        return 'report'
      }),
    )
    expect(call('resize_blend_in_component', scene, [PLACEMENT, MEMBER, 0, '{}'], () => 'smaller')).toBe('smaller')
  })
})

describe('unions across filaments', () => {
  it('Rejoin of pieces of two filaments is refused; of one, let through', () => {
    const { scene } = stubScene(new Map())
    refusal(() => call('rejoin_as_one_solid', scene, [BigUint64Array.of(PETG_OBJECT, 2n)]))
    expect(call('rejoin_as_one_solid', scene, [BigUint64Array.of(2n, 3n)])).toBe('ran')
  })

  it('a union in a component or through a placement counts the members, read through the placement', () => {
    const { scene } = stubScene(new Map())
    refusal(() => call('boolean_in_component', scene, [8n, 0, PETG_OBJECT, 2n]))
    expect(call('boolean_in_component', scene, [8n, 1, PETG_OBJECT, 2n])).toBe('ran')
    refusal(() => call('boolean_through_placement_json', scene, [BigUint64Array.of(PLACEMENT), undefined, 2n, 0]))
    expect(call('boolean_through_placement_json', scene, [BigUint64Array.of(PLACEMENT), undefined, 2n, 1])).toBe('ran')
    refusal(() => call('boolean_nodes_many', scene, [0, Uint8Array.of(2, 0), BigUint64Array.of(PLACEMENT, 2n)]))
  })

  it('nothing is refused with no filament selected', () => {
    resetFilamentsForTest([], null)
    const { scene } = stubScene(new Map())
    expect(call('boolean', scene, [0, PETG_OBJECT, 2n])).toBe('ran')
    expect(call('rejoin_as_one_solid', scene, [BigUint64Array.of(PETG_OBJECT, 2n)])).toBe('ran')
  })
})
