import type { DealListing } from '@/lib/queries'
import DealRow from './DealRow'
import { dealsInputStyle } from './DealsFilterBar'

export default function LowConfidenceDeals({
  deals,
  nextOffset,
  loading,
  onLoadMore,
}: {
  deals: DealListing[]
  nextOffset: number | null
  loading: boolean
  onLoadMore: (offset: number) => void
}) {
  if (deals.length === 0) return null
  return (
    <div style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: '1.1em' }}>Rougher estimates</h2>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: -8 }}>
        Products we've only ever seen listed once, or with no price estimate at all. There could be real deals in here,
        but the numbers are shakier - take with a grain of salt. Not sorted by profit.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {deals.map((d) => (
          <DealRow key={d.listing_id} deal={d} />
        ))}
      </div>
      {nextOffset !== null && (
        <button
          type="button"
          onClick={() => onLoadMore(nextOffset)}
          disabled={loading}
          className="mono"
          style={{ ...dealsInputStyle, marginTop: 12, cursor: 'pointer' }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
