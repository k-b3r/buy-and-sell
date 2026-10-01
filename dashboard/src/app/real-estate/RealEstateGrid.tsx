'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealEstateListing } from '@/lib/queries'
import { realEstatePageQuery } from '@/lib/realEstate'
import RealEstateCard from './RealEstateCard'

// Server renders page 1; further pages load when the sentinel below the grid
// scrolls into view, same IntersectionObserver pattern as DealsClient. Keyed
// on the filter query by the page, so changing filters remounts it fresh.
export default function RealEstateGrid({
  initialListings,
  initialNextPage,
  params,
  emptyText,
}: {
  initialListings: RealEstateListing[]
  initialNextPage: number | null
  params: Record<string, string | undefined>
  emptyText: string
}) {
  const [listings, setListings] = useState(initialListings)
  const [nextPage, setNextPage] = useState(initialNextPage)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const loadMore = useCallback(async () => {
    if (nextPage === null || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/real-estate?${realEstatePageQuery(params, nextPage)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { listings: RealEstateListing[]; nextPage: number | null }
      setListings((prev) => {
        const seen = new Set(prev.map((l) => l.id))
        return [...prev, ...data.listings.filter((l) => !seen.has(l.id))]
      })
      setNextPage(data.nextPage)
      setFailed(false)
    } catch {
      // Stop auto-retrying on scroll; the button below lets the user try again.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [nextPage, loading, params])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextPage === null || failed) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextPage, failed, loadMore])

  if (listings.length === 0) return <p style={{ color: 'var(--color-text-muted)' }}>{emptyText}</p>

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {listings.map((l) => (
          <RealEstateCard key={l.id} l={l} />
        ))}
      </div>
      <div
        ref={sentinelRef}
        style={{ padding: '20px 0', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.85em' }}
      >
        {loading ? 'Loading more…' : null}
        {failed ? (
          <button
            type="button"
            onClick={() => {
              setFailed(false)
              loadMore()
            }}
            style={{ cursor: 'pointer' }}
          >
            Couldn&apos;t load more. Retry
          </button>
        ) : null}
      </div>
    </div>
  )
}
