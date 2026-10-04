import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildListingsQueryString,
  type ListingsFilters,
  type ListingsPage,
  type PaginatedListingSummary,
} from './listingsFilters'

// Listings are fetched page-by-page from /api/products/[id]/listings
// (see listingsFilters.ts's paginateListings) - same infinite-scroll shape
// as ProductListClient.tsx's products fetch. `listings` only ever holds the
// pages loaded so far; matchedCount/allIds come from the server on every
// fetch and always describe the *entire* filtered/sorted set.
export function useListingsPages({
  productId,
  filters,
  initialListings,
  initialNextOffset,
  initialMatchedCount,
  initialAllIds,
}: {
  productId: number
  filters: ListingsFilters
  initialListings: PaginatedListingSummary[]
  initialNextOffset: number | null
  initialMatchedCount: number
  initialAllIds: string[]
}) {
  const { view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand } = filters
  const [listings, setListings] = useState(initialListings)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [matchedCount, setMatchedCount] = useState(initialMatchedCount)
  const [allIds, setAllIds] = useState(initialAllIds)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const fetchPage = useCallback(
    async (pageFilters: ListingsFilters, offset: number, replace: boolean) => {
      setLoading(true)
      const params = new URLSearchParams(buildListingsQueryString(pageFilters))
      params.set('offset', String(offset))
      const res = await fetch(`/api/products/${productId}/listings?${params}`)
      const data: ListingsPage = await res.json()
      setListings((prev) => {
        if (replace) return data.listings
        const seen = new Set(prev.map((l) => l.id))
        return [...prev, ...data.listings.filter((l) => !seen.has(l.id))]
      })
      setNextOffset(data.nextOffset)
      setMatchedCount(data.matchedCount)
      setAllIds(data.allIds)
      setLoading(false)
    },
    [productId],
  )

  // Tracks the filters last applied to a fetch, same "distinguish a local
  // edit from the initial mount" purpose as ProductListClient's
  // appliedFiltersRef - without it, the effect below would immediately
  // re-fetch page 0 on mount even though initialListings already matches
  // initialFilters. `view` is deliberately excluded - it's a pure display
  // toggle, not something the server filters/sorts on.
  const appliedFiltersRef = useRef({ sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand })

  useEffect(() => {
    const applied = appliedFiltersRef.current
    if (
      sortKey === applied.sortKey &&
      listedWithinDays === applied.listedWithinDays &&
      hideSold === applied.hideSold &&
      negotiableOnly === applied.negotiableOnly &&
      selectedBand === applied.selectedBand
    )
      return
    const timeout = setTimeout(() => {
      appliedFiltersRef.current = { sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand }
      void fetchPage({ view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand }, 0, true)
    }, 300)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view is fixed per mount; refetch only when a filter changes
  }, [sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand, fetchPage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading)
          void fetchPage({ view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand }, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view is fixed per mount; reobserve only when paging or filter state changes
  }, [nextOffset, loading, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand, fetchPage])

  // sessionStorage, not React state/context: the listing modal is a
  // separate intercepted route (its own component tree, see
  // @modal/(.)listings/[id]/page.tsx), reached via full navigation from
  // this component's perspective - there's no shared React tree to pass
  // this through as a prop. Read by Modal.tsx to drive prev/next cycling.
  // Sourced from allIds (the full filtered/sorted set, server-computed),
  // not the `listings` currently loaded client-side, so cycling still spans
  // every matching listing regardless of how far the user has scrolled.
  useEffect(() => {
    try {
      sessionStorage.setItem('listingCycleIds', JSON.stringify(allIds))
    } catch {
      // sessionStorage unavailable (private browsing, disabled storage) -
      // cycling just won't have a list to work from, not worth failing over.
    }
  }, [allIds])

  return { listings, nextOffset, matchedCount, loading, sentinelRef }
}
