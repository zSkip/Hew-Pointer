import { describe, expect, it } from 'vitest'
import { plateFilamentMap } from './buildMaterial'
import type { Filament } from './filaments'

const pla: Filament = { name: 'Brand PLA', type: 'PLA', vendor: 'Brand', colour: '#FFFFFF', density: 1.24, softeningTemp: 45, slot: 1 }
const petg: Filament = { name: 'Brand PETG', type: 'PETG', vendor: 'Brand', colour: '#0000FF', density: 1.27, softeningTemp: 70, slot: null }

describe('plateFilamentMap', () => {
  it('maps each material name to the preset of the host list it stands for', () => {
    const map = plateFilamentMap(
      [
        { name: 'Brand PLA', link: { preset: 'Brand PLA', type: 'PLA', vendor: 'Brand' } },
        // Linked to a preset the selected printer does not list: same type instead.
        { name: 'Other PETG', link: { preset: 'Other PETG', type: 'PETG', vendor: 'Other' } },
      ],
      [pla, petg],
    )
    expect(map).toEqual({ 'Brand PLA': 'Brand PLA', 'Other PETG': 'Brand PETG' })
  })

  it('keeps the linked preset when the list has nothing of its type', () => {
    expect(plateFilamentMap([{ name: 'Old TPU', link: { preset: 'Old TPU', type: 'TPU', vendor: '' } }], [pla])).toEqual({ 'Old TPU': 'Old TPU' })
  })

  it('skips unnamed materials and keeps the first of a repeated name', () => {
    const map = plateFilamentMap(
      [
        { name: '', link: { preset: 'Brand PLA', type: 'PLA', vendor: '' } },
        { name: 'Shared', link: { preset: 'Brand PLA', type: 'PLA', vendor: '' } },
        { name: 'Shared', link: { preset: 'Brand PETG', type: 'PETG', vendor: '' } },
      ],
      [pla, petg],
    )
    expect(map).toEqual({ Shared: 'Brand PLA' })
  })
})
