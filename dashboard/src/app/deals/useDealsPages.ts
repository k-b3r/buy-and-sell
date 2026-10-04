import { useCallback, useEffect, useRef, useState } from 'react'
import type { DealListing } from '@/lib/queries'
import { EMPTY_FILTERS, buildDealsParams, type DealsFilters } from './dealsFilters'

interface DealsPage {
  deals: DealListing[]
  nextOffset: number | null
}

// Two buckets from /api/deals: the main list (infinite scroll via
// sentinelRef) and the low-confidence list (explicit "Load more").
export function useDealsPages({
  filters,
  initialDeals,
  initialNextOffset,
  initialLowConfidenceDeals,
  initialLowConfidenceNextOffset,
}: {
  filters: DealsFilters
  initialDeals: DealListing[]
  initialNextOffset: number | null
  initialLowConfidenceDeals: DealListing[]
  initialLowConfidenceNextOffset: number | null
}) {
  const [deals, setDeals] = useState(initialDeals)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [loading, setLoading] = useState(false)
  const [lowConfidenceDeals, setLowConfidenceDeals] = useState(initialLowConfidenceDeals)
  const [lowConfidenceNextOffset, setLowConfidenceNextOffset] = useState(initialLowConfidenceNextOffset)
  const [lowConfidenceLoading, setLowConfidenceLoading] = useState(false)
  // Distinct from loading (infinite-scroll "load more") - true only while a
  // filter change's refetch is in flight, so the stale list gets swapped for
  // skeleton rows instead of sitting there while a spinner appends below it.
  const [filtersLoading, setFiltersLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const appliedFiltersRef = useRef(EMPTY_FILTERS)

  const fetchPage = useCallback(async (f: DealsFilters, offset: number, replace: boolean) => {
    setLoading(true)
    const res = await fetch(`/api/deals?${buildDealsParams(f, offset, false)}`)
    const data: DealsPage = await res.json()
    setDeals((prev) => {
      if (replace) return data.deals
      const seen = new Set(prev.map((d) => d.listing_id))
      return [...prev, ...data.deals.filter((d) => !seen.has(d.listing_id))]
    })
    setNextOffset(data.nextOffset)
    setLoading(false)
  }, [])

  const fetchLowConfidencePage = useCallback(async (f: DealsFilters, offset: number) => {
    setLowConfidenceLoading(true)
    const res = await fetch(`/api/deals?${buildDealsParams(f, offset, true)}`)
    const data: DealsPage = await res.json()
    setLowConfidenceDeals((prev) => [...prev, ...data.deals])
    setLowConfidenceNextOffset(data.nextOffset)
    setLowConfidenceLoading(false)
  }, [])

  // Filter edits debounce into a refetch of both buckets - same shape as
  // ProductListClient's search debounce, minus the URL/sessionStorage sync
  // (skipped for v1: a shared-link/persisted-filter deals view is less
  // valuable than for the product catalog, since "what's a good deal right
  // now" is inherently a moment-in-time view, not something worth bookmarking).
  useEffect(() => {
    const applied = appliedFiltersRef.current
    if (JSON.stringify(filters) === JSON.stringify(applied)) return
    const timeout = setTimeout(() => {
      appliedFiltersRef.current = filters
      setLowConfidenceDeals([])
      setFiltersLoading(true)
      void Promise.all([fetchPage(filters, 0, true), fetchLowConfidencePage(filters, 0)]).finally(() =>
        setFiltersLoading(false),
      )
    }, 300)
    return () => clearTimeout(timeout)
  }, [filters, fetchPage, fetchLowConfidencePage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading) void fetchPage(filters, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, loading, filters, fetchPage])

  return {
    deals,
    nextOffset,
    loading,
    filtersLoading,
    sentinelRef,
    lowConfidenceDeals,
    lowConfidenceNextOffset,
    lowConfidenceLoading,
    fetchLowConfidencePage,
  }
}
