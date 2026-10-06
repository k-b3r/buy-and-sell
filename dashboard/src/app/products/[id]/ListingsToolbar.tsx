import type { CSSProperties } from 'react'
import type { DiscountBand } from '@/lib/shared.generated'
import { LISTED_WITHIN_OPTIONS, SORT_OPTIONS, type ListingsFilters, type SortKey } from './listingsFilters'

function toggleButtonStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--color-text)' : 'transparent',
    color: active ? 'var(--color-bg)' : 'var(--color-text)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    padding: '4px 12px',
    fontSize: '0.9em',
    cursor: 'pointer',
  }
}

const selectStyle: CSSProperties = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: '0.9em',
}

function discountBandBadgeStyle(active: boolean): CSSProperties {
  return {
    padding: '2px 10px',
    borderRadius: 12,
    fontSize: '0.85em',
    fontWeight: 'bold',
    background: 'var(--color-signal)',
    color: 'var(--color-bg)',
    border: active ? '2px solid var(--color-text)' : '2px solid transparent',
    cursor: 'pointer',
    opacity: active ? 1 : 0.85,
  }
}

export function DiscountBandFilter({
  discountBands,
  selectedBand,
  onToggleBand,
}: {
  discountBands: DiscountBand[]
  selectedBand: number | null
  onToggleBand: (bandFloor: number) => void
}) {
  if (discountBands.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
      {discountBands.map((band) => (
        <button
          key={band.bandFloor}
          className="mono"
          onClick={() => onToggleBand(band.bandFloor)}
          style={discountBandBadgeStyle(selectedBand === band.bandFloor)}
        >
          {band.bandFloor}-{band.bandFloor + 9}% off ×{band.count}
        </button>
      ))}
    </div>
  )
}

export function ListingsToolbar({
  filters,
  onChange,
  filtersActive,
  onClear,
  matchedCount,
  totalListingCount,
}: {
  filters: ListingsFilters
  onChange: (patch: Partial<ListingsFilters>) => void
  filtersActive: boolean
  onClear: () => void
  matchedCount: number
  totalListingCount: number
}) {
  const { view, sortKey, listedWithinDays, hideSold, negotiableOnly } = filters
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <button
        onClick={() => onChange({ view: 'cards' })}
        aria-pressed={view === 'cards'}
        style={toggleButtonStyle(view === 'cards')}
      >
        Cards
      </button>
      <button
        onClick={() => onChange({ view: 'list' })}
        aria-pressed={view === 'list'}
        style={toggleButtonStyle(view === 'list')}
      >
        List
      </button>
      <select value={sortKey} onChange={(e) => onChange({ sortKey: e.target.value as SortKey })} style={selectStyle}>
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            Sort: {o.label}
          </option>
        ))}
      </select>
      <select
        value={listedWithinDays}
        onChange={(e) => onChange({ listedWithinDays: Number(e.target.value) })}
        style={selectStyle}
      >
        {LISTED_WITHIN_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            Listed: {o.label}
          </option>
        ))}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.9em', cursor: 'pointer' }}>
        <input type="checkbox" checked={hideSold} onChange={(e) => onChange({ hideSold: e.target.checked })} />
        Hide sold
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.9em', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={negotiableOnly}
          onChange={(e) => onChange({ negotiableOnly: e.target.checked })}
        />
        Negotiable only
      </label>
      {filtersActive && (
        <button onClick={onClear} style={toggleButtonStyle(false)}>
          Clear
        </button>
      )}
      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
        {matchedCount} of {totalListingCount}
      </span>
    </div>
  )
}
