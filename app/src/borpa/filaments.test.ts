import { afterEach, describe, expect, it } from 'vitest'
import {
  GENERIC_FILAMENTS,
  chooseSelection,
  getFilamentState,
  parseFilaments,
  resetFilamentsForTest,
  selectFilament,
  selectedFilament,
  setFilaments,
  subscribeFilaments,
  type Filament,
} from './filaments'

const pla: Filament = { name: 'Brand PLA', type: 'PLA', vendor: 'Brand', colour: '#FFFFFF', density: 1.24, softeningTemp: 45, slot: null }
const petg: Filament = { name: 'Brand PETG', type: 'PETG', vendor: 'Brand', colour: '#0000FF', density: 1.27, softeningTemp: 70, slot: 2 }

afterEach(() => resetFilamentsForTest(GENERIC_FILAMENTS))

describe('filaments', () => {
  it('starts outside Borpa with the generic types, one selected', () => {
    resetFilamentsForTest(GENERIC_FILAMENTS)
    const { filaments, selected } = getFilamentState()
    expect(filaments.map((f) => f.type)).toEqual(['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'])
    expect(selected).toBe('Generic PLA')
  })

  it('reads the host list, dropping unusable entries and repeated names', () => {
    const parsed = parseFilaments([
      { name: 'Brand PLA', type: 'PLA', vendor: 'Brand', colour: '#ffffff', density: 1.24, softeningTemp: 45, slot: null },
      { name: '', type: 'PLA' },
      { name: 'Brand PLA', type: 'PETG' },
      'not a filament',
      { name: 'Odd', colour: 'red', density: 'heavy', slot: 0 },
    ])
    expect(parsed).toEqual([
      pla,
      { name: 'Odd', type: '', vendor: '', colour: '#F2754E', density: null, softeningTemp: null, slot: null },
    ])
    expect(parseFilaments({ not: 'a list' })).toEqual([])
  })

  it('keeps the selection when the new list still has it, else picks the lowest slot, else the first', () => {
    expect(chooseSelection([pla, petg], 'Brand PLA')).toBe('Brand PLA')
    expect(chooseSelection([pla, petg], 'Gone')).toBe('Brand PETG')
    expect(chooseSelection([pla], 'Gone')).toBe('Brand PLA')
    expect(chooseSelection([], 'Gone')).toBeNull()
  })

  it('tells subscribers when the host sends a new list, and selects by name', () => {
    let calls = 0
    const stop = subscribeFilaments(() => calls++)
    setFilaments([pla, petg])
    expect(calls).toBe(1)
    expect(selectedFilament()?.name).toBe('Brand PETG')
    selectFilament('Brand PLA')
    expect(selectedFilament()).toEqual(pla)
    // Not in the list: ignored.
    selectFilament('Nope')
    expect(selectedFilament()).toEqual(pla)
    expect(calls).toBe(2)
    stop()
  })
})
