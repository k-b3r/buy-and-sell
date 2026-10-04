'use client'

import { useState } from 'react'
import type { DealListing } from '@/lib/queries'
import { Spinner, SkeletonDealRow } from '../Skeleton'
import DealRow from './DealRow'
import DealsFilterBar from './DealsFilterBar'
import LowConfidenceDeals from './LowConfidenceDeals'
import { EMPTY_FILTERS, type DealsFilters } from './dealsFilters'
import { useDealsPages } from './useDealsPages'

export default function DealsClient({
  initialDeals,
  initialNextOffset,
  initialLowConfidenceDeals,
  initialLowConfidenceNextOffset,
}: {
  initialDeals: DealListing[]
  initialNextOffset: number | null
  initialLowConfidenceDeals: DealListing[]
  initialLowConfidenceNextOffset: number | null
}) {
  const [filters, setFilters] = useState<DealsFilters>(EMPTY_FILTERS)
  const {
    deals,
    nextOffset,
    loading,
    filtersLoading,
    sentinelRef,
    lowConfidenceDeals,
    lowConfidenceNextOffset,
    lowConfidenceLoading,
    fetchLowConfidencePage,
  } = useDealsPages({
    filters,
    initialDeals,
    initialNextOffset,
    initialLowConfidenceDeals,
    initialLowConfidenceNextOffset,
  })

  return (
    <div>
      <DealsFilterBar filters={filters} setFilters={setFilters} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtersLoading
          ? Array.from({ length: 6 }, (_, i) => <SkeletonDealRow key={i} />)
          : deals.map((d) => <DealRow key={d.listing_id} deal={d} />)}
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
      {!filtersLoading && loading && <Spinner label="Loading more deals" />}
      {!filtersLoading && !loading && nextOffset === null && deals.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!filtersLoading && !loading && deals.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>No deals match these filters.</p>
      )}

      <LowConfidenceDeals
        deals={lowConfidenceDeals}
        nextOffset={lowConfidenceNextOffset}
        loading={lowConfidenceLoading}
        onLoadMore={(offset) => void fetchLowConfidencePage(filters, offset)}
      />
    </div>
  )
}
