import { unstable_cache } from 'next/cache'
import { getListingDetail, getSavedListings } from './queries'
import type { ListingDetail, SavedListingSummary } from './queries'

// Kept out of queries.ts on purpose: that module is imported directly by
// vitest (queries.test.ts), and next/cache's unstable_cache touches Next's
// request-scoped internals that don't exist outside a running Next server.
// The wrapped functions are RPC calls to server/ now (see queries.ts), so
// there's no connection handle to thread through - only real arguments,
// which are exactly what the cache key should be built from.

const REVALIDATE_SECONDS = 300

export function getListingDetailCached(listingId: string): Promise<ListingDetail | null> {
  return unstable_cache(() => getListingDetail(listingId), ['listing-detail', listingId], {
    tags: [`listing:${listingId}`],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getSavedListingsCached(): Promise<SavedListingSummary[]> {
  return unstable_cache(() => getSavedListings(), ['saved-listings'], {
    tags: ['saved-listings'],
    revalidate: REVALIDATE_SECONDS,
  })()
}
