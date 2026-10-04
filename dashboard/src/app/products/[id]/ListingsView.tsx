'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import type { DiscountBand } from '@/lib/pricing'
import { getActiveListingId } from '../../listings/[id]/cycle'
import { Spinner } from '../../Skeleton'
import ListingsGrid from './ListingsGrid'
import ListingsTable from './ListingsTable'
import { DiscountBandFilter, ListingsToolbar } from './ListingsToolbar'
import {
  DEFAULT_HIDE_SOLD,
  DEFAULT_LISTED_WITHIN_DAYS,
  DEFAULT_LISTINGS_FILTERS,
  DEFAULT_NEGOTIABLE_ONLY,
  DEFAULT_SELECTED_BAND,
  hasActiveFilters,
  listingDetailHref,
  type ListingsFilters,
  type PaginatedListingSummary,
} from './listingsFilters'
import { useListingsPages } from './useListingsPages'

export default function ListingsView({
  initialListings,
  initialNextOffset,
  initialMatchedCount,
  initialAllIds,
  totalListingCount,
  discountBands,
  productId,
  initialFilters,
}: {
  initialListings: PaginatedListingSummary[]
  initialNextOffset: number | null
  initialMatchedCount: number
  initialAllIds: string[]
  totalListingCount: number
  discountBands: DiscountBand[]
  productId: number
  initialFilters?: ListingsFilters
}) {
  const [filters, setFilters] = useState<ListingsFilters>(initialFilters ?? DEFAULT_LISTINGS_FILTERS)
  const activeListingId = getActiveListingId(usePathname())
  const { listings, nextOffset, matchedCount, loading, sentinelRef } = useListingsPages({
    productId,
    filters,
    initialListings,
    initialNextOffset,
    initialMatchedCount,
    initialAllIds,
  })

  function updateFilters(patch: Partial<ListingsFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }))
  }

  function toggleBand(bandFloor: number) {
    setFilters((prev) => ({ ...prev, selectedBand: prev.selectedBand === bandFloor ? null : bandFloor }))
  }

  function clearFilters() {
    updateFilters({
      listedWithinDays: DEFAULT_LISTED_WITHIN_DAYS,
      hideSold: DEFAULT_HIDE_SOLD,
      negotiableOnly: DEFAULT_NEGOTIABLE_ONLY,
      selectedBand: DEFAULT_SELECTED_BAND,
    })
  }

  const listingHref = (listingId: string) => listingDetailHref(listingId, filters)

  return (
    <div>
      <DiscountBandFilter discountBands={discountBands} selectedBand={filters.selectedBand} onToggleBand={toggleBand} />

      <ListingsToolbar
        filters={filters}
        onChange={updateFilters}
        filtersActive={hasActiveFilters(filters)}
        onClear={clearFilters}
        matchedCount={matchedCount}
        totalListingCount={totalListingCount}
      />

      {filters.view === 'list' ? (
        <ListingsTable
          listings={listings}
          activeListingId={activeListingId}
          productId={productId}
          listingHref={listingHref}
        />
      ) : (
        <ListingsGrid
          listings={listings}
          activeListingId={activeListingId}
          productId={productId}
          listingHref={listingHref}
        />
      )}
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && <Spinner label="Loading more listings" />}
      {!loading && nextOffset === null && listings.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!loading && listings.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No listings found.</p>}
    </div>
  )
}
