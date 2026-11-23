import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { FilamentSidebar, filamentMatches } from './FilamentSidebar'
import { GENERIC_FILAMENTS, getFilamentState, resetFilamentsForTest, setFilaments, type Filament } from '../borpa/filaments'

afterEach(() => resetFilamentsForTest(GENERIC_FILAMENTS))

const many: Filament[] = Array.from({ length: 8 }, (_, i) => ({
  name: `Vendor ${i % 2 === 0 ? 'PLA' : 'PETG'} ${i}`,
  type: i % 2 === 0 ? 'PLA' : 'PETG',
  vendor: 'Vendor',
  colour: '#123456',
  density: null,
  softeningTemp: null,
  slot: i === 3 ? 1 : null,
}))

describe('FilamentSidebar', () => {
  it('lists the filaments with the selected one highlighted, and selects on click', () => {
    resetFilamentsForTest(GENERIC_FILAMENTS, 'Generic PLA')
    render(<FilamentSidebar />)
    const rows = screen.getAllByTestId('filament-row')
    expect(rows.map((r) => r.getAttribute('data-filament'))).toEqual(GENERIC_FILAMENTS.map((f) => f.name))
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.click(rows[1])
    expect(getFilamentState().selected).toBe('Generic PETG')
    expect(screen.getAllByTestId('filament-row')[1].getAttribute('aria-selected')).toBe('true')
  })

  it('follows a new list from the host, with its slots', () => {
    render(<FilamentSidebar />)
    act(() => setFilaments(many))
    expect(screen.getAllByTestId('filament-row')).toHaveLength(8)
    // The filament in slot 1 is selected when the old selection is gone.
    expect(getFilamentState().selected).toBe('Vendor PETG 3')
    expect(screen.getByText('Slot 1')).toBeInTheDocument()
  })

  it('searches by name, type and vendor', () => {
    resetFilamentsForTest(many)
    render(<FilamentSidebar />)
    fireEvent.change(screen.getByTestId('filament-search'), { target: { value: 'petg' } })
    expect(screen.getAllByTestId('filament-row')).toHaveLength(4)
    expect(filamentMatches(many[0], 'vendor pla')).toBe(true)
    expect(filamentMatches(many[0], 'petg')).toBe(false)
  })

  it('offers the highlighted filament for the selected Objects', () => {
    resetFilamentsForTest(GENERIC_FILAMENTS, 'Generic ABS')
    const onUse = vi.fn()
    const { rerender } = render(<FilamentSidebar selectedObjectCount={0} onUseForSelection={onUse} />)
    expect(screen.queryByTestId('filament-use-for-selection')).toBeNull()
    rerender(<FilamentSidebar selectedObjectCount={2} onUseForSelection={onUse} />)
    fireEvent.click(screen.getByTestId('filament-use-for-selection'))
    expect(onUse).toHaveBeenCalledWith(GENERIC_FILAMENTS.find((f) => f.name === 'Generic ABS'))
  })

  it('says so when there are no filaments', () => {
    resetFilamentsForTest([], null)
    render(<FilamentSidebar />)
    expect(screen.getByTestId('filament-empty')).toBeInTheDocument()
  })
})
