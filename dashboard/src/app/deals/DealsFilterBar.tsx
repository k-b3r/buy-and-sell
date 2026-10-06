import type { Dispatch, SetStateAction } from 'react'
import { PRODUCT_CATEGORIES } from '@/lib/shared.generated'
import type { DealsConfidenceTier } from '@/lib/queries'
import type { DealsFilters } from './dealsFilters'

// Shared with the low-confidence section's "Load more" button.
export const dealsInputStyle = {
  padding: 8,
  borderRadius: 4,
  fontSize: '0.85em',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
}

export default function DealsFilterBar({
  filters,
  setFilters,
}: {
  filters: DealsFilters
  setFilters: Dispatch<SetStateAction<DealsFilters>>
}) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      <input
        type="search"
        placeholder="Search title or product"
        value={filters.search}
        onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        className="mono"
        style={{ ...dealsInputStyle, width: 220 }}
      />
      <select
        value={filters.category ?? ''}
        onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value || null }))}
        className="mono"
        style={dealsInputStyle}
      >
        <option value="">All categories</option>
        {PRODUCT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        value={filters.minTier}
        onChange={(e) => setFilters((f) => ({ ...f, minTier: e.target.value as DealsConfidenceTier | '' }))}
        className="mono"
        style={dealsInputStyle}
      >
        <option value="">Any reliability</option>
        <option value="peer_listings">Similar listings or better</option>
        <option value="sold_comps">Recent sales only</option>
      </select>
      <input
        type="number"
        placeholder="Min profit ₱"
        value={filters.minProfit}
        onChange={(e) => setFilters((f) => ({ ...f, minProfit: e.target.value }))}
        className="mono"
        style={{ ...dealsInputStyle, width: 130 }}
      />
      <input
        type="number"
        placeholder="Max days listed"
        value={filters.maxDaysListed}
        onChange={(e) => setFilters((f) => ({ ...f, maxDaysListed: e.target.value }))}
        className="mono"
        style={{ ...dealsInputStyle, width: 140 }}
      />
      <button
        type="button"
        onClick={() => setFilters((f) => ({ ...f, soldOnly: !f.soldOnly }))}
        className="mono"
        style={{
          ...dealsInputStyle,
          cursor: 'pointer',
          background: filters.soldOnly ? 'var(--color-signal)' : 'var(--color-surface)',
          color: filters.soldOnly ? 'var(--color-bg)' : 'var(--color-text)',
        }}
      >
        {filters.soldOnly ? 'Sold' : 'Active'}
      </button>
    </div>
  )
}
