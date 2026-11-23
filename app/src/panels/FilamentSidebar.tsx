/**
 * FilamentSidebar — the filaments a model is built in.
 *
 * Lists the filaments the host sends (the selected printer's; a few generic
 * types outside Borpa, borpa/filaments.ts), searchable by name, type and
 * vendor. The selected filament is highlighted: whatever is drawn and
 * extruded next is made of it (borpa/filamentScene.ts). With Objects
 * selected, "Use for selection" gives them the highlighted filament.
 */

import { useMemo, useState, useSyncExternalStore } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { getFilamentState, selectFilament, subscribeFilaments, type Filament } from '../borpa/filaments'

interface Props {
  /** Filament preset names the selected Objects are made of (Object Info's
   *  union), marked in the list. */
  selectionFilaments?: readonly string[]
  /** How many Objects are selected; with any, "Use for selection" shows. */
  selectedObjectCount?: number
  /** Give the selected Objects this filament. */
  onUseForSelection?: (filament: Filament) => void
}

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '11px',
  color: 'var(--text-secondary, #ccc)',
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  fontSize: '11px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, #555)',
  borderRadius: '3px',
  padding: '3px 5px',
  boxSizing: 'border-box',
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  padding: '4px 6px',
  borderRadius: '3px',
  border: '1px solid transparent',
  background: 'none',
  color: 'var(--text-primary, #eee)',
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: '11px',
}

const SELECTED_STYLE: React.CSSProperties = {
  background: 'var(--accent-soft, rgba(116, 95, 168, 0.25))',
  borderColor: 'var(--accent, #745FA8)',
}

const BTN_STYLE: React.CSSProperties = {
  fontSize: '11px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, #555)',
  borderRadius: '3px',
  padding: '3px 8px',
  cursor: 'pointer',
}

/** Whether `f` matches every word of `query` (name, type or vendor). */
export function filamentMatches(f: Filament, query: string): boolean {
  const hay = `${f.name} ${f.type} ${f.vendor}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => hay.includes(w))
}

export function FilamentSidebar({ selectionFilaments = [], selectedObjectCount = 0, onUseForSelection }: Props) {
  const { t } = useLingui()
  const { filaments, selected } = useSyncExternalStore(subscribeFilaments, getFilamentState, getFilamentState)
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filaments.filter((f) => filamentMatches(f, query)), [filaments, query])
  const current = filaments.find((f) => f.name === selected) ?? null
  const inSelection = new Set(selectionFilaments)
  const currentName = current?.name ?? ''

  return (
    <div style={PANEL_STYLE} data-testid="filament-sidebar">
      {filaments.length === 0 ? (
        <div data-testid="filament-empty">
          <Trans>No filaments yet. Choose a printer in Borpa to list its filaments.</Trans>
        </div>
      ) : (
        <>
          {filaments.length > 6 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Search filaments`}
              aria-label={t`Search filaments`}
              style={INPUT_STYLE}
              data-testid="filament-search"
            />
          )}
          <div role="listbox" aria-label={t`Filaments`} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {shown.map((f) => {
              const isSelected = f.name === selected
              const name = f.name
              const slot = f.slot
              const detail = [f.type, f.vendor].filter((s) => s !== '').join(' · ')
              return (
                <button
                  key={f.name}
                  role="option"
                  aria-selected={isSelected}
                  data-testid="filament-row"
                  data-filament={f.name}
                  onClick={() => selectFilament(f.name)}
                  title={isSelected ? t`New geometry is built in ${name}` : t`Build in ${name}`}
                  style={{ ...ROW_STYLE, ...(isSelected ? SELECTED_STYLE : {}) }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      border: '1px solid var(--border-strong, #555)',
                      background: f.colour,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSelected ? 600 : 400 }}>
                      {f.name}
                    </span>
                    {detail !== '' && (
                      <span style={{ color: 'var(--text-secondary, #aaa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {detail}
                      </span>
                    )}
                  </span>
                  {inSelection.has(f.name) && (
                    <span title={t`The selection is made of this`} aria-label={t`In the selection`} style={{ flexShrink: 0 }}>
                      ●
                    </span>
                  )}
                  {slot !== null && (
                    <span style={{ flexShrink: 0, color: 'var(--text-secondary, #aaa)' }}>
                      <Trans>Slot {slot}</Trans>
                    </span>
                  )}
                </button>
              )
            })}
            {shown.length === 0 && (
              <div>
                <Trans>No filament matches.</Trans>
              </div>
            )}
          </div>
          {selectedObjectCount > 0 && current !== null && onUseForSelection !== undefined && (
            <button style={BTN_STYLE} onClick={() => onUseForSelection(current)} data-testid="filament-use-for-selection">
              <Trans>Use {currentName} for selection</Trans>
            </button>
          )}
        </>
      )}
    </div>
  )
}
