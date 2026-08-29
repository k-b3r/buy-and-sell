'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { DiscountBand } from '@/lib/queries'
import { isListingPriceNegotiable } from '@/lib/queries'
import { getActiveListingId } from '../../listings/[id]/cycle'
import SaveButton from '../../SaveButton'
import {
  DEFAULT_HIDE_SOLD,
  DEFAULT_LISTED_WITHIN_DAYS,
  DEFAULT_NEGOTIABLE_ONLY,
  DEFAULT_SELECTED_BAND,
  DEFAULT_SORT_KEY,
  DEFAULT_VIEW,
  LISTED_WITHIN_OPTIONS,
  SORT_OPTIONS,
  buildListingsQueryString,
  type ListingsFilters,
  type ListingsPage,
  type PaginatedListingSummary,
  type SortKey,
  type View,
} from './listingsFilters'

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

const soldBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-text-muted)',
  color: 'var(--color-bg)',
}

function SoldBadge() {
  return <span style={soldBadgeStyle}>Sold</span>
}

const repostBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-text-muted)',
  color: 'var(--color-bg)',
}

function RepostBadge() {
  return <span style={repostBadgeStyle}>Possible repost</span>
}

// Solid fill, not a border-only pill - this now also renders as an overlay
// on top of arbitrary product photos (card view), where an outline-only
// badge wouldn't reliably read against a busy image.
const negotiableBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-accent)',
  color: 'var(--color-bg)',
}

function NegotiableBadge() {
  return <span style={negotiableBadgeStyle}>Negotiable</span>
}

function discountBadgeStyle(percent: number): CSSProperties {
  return {
    display: 'inline-block',
    marginLeft: 8,
    padding: '1px 8px',
    borderRadius: 12,
    fontSize: '0.75em',
    background: percent > 0 ? 'var(--color-signal)' : 'var(--color-text-muted)',
    color: 'var(--color-bg)',
  }
}

// null covers both "not enough sibling listings to compare" and "this
// listing's price is itself a magnitude outlier / placeholder" - see
// computeListingDiscount. Zero is a real result (priced exactly at the
// reference), just not worth a badge.
function DiscountBadge({ percent }: { percent: number | null }) {
  if (percent === null || percent === 0) return null
  return (
    <span style={discountBadgeStyle(percent)}>
      {percent > 0 ? `${percent}% below avg` : `${Math.abs(percent)}% above avg`}
    </span>
  )
}

// price_review's range replaces the recorded price display when it has a real
// read on it; a review row with no determinable price (both null) falls back
// to the recorded price, same as no review row at all. is_negotiable is a
// wholly separate signal (NegotiableBadge), never coupled to which price shows.
function formatListingPrice(l: PaginatedListingSummary): string {
  const review = l.price_review
  if (review && (review.price_low !== null || review.price_high !== null)) {
    if (review.price_low === review.price_high) {
      return review.price_low !== null ? `₱${review.price_low.toLocaleString()}` : '—'
    }
    if (review.price_low !== null && review.price_high !== null) {
      return `₱${review.price_low.toLocaleString()}–₱${review.price_high.toLocaleString()}`
    }
  }
  return l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : '—'
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
  const [view, setView] = useState<View>(initialFilters?.view ?? DEFAULT_VIEW)
  const [sortKey, setSortKey] = useState<SortKey>(initialFilters?.sortKey ?? DEFAULT_SORT_KEY)
  const [listedWithinDays, setListedWithinDays] = useState(initialFilters?.listedWithinDays ?? DEFAULT_LISTED_WITHIN_DAYS)
  const [hideSold, setHideSold] = useState(initialFilters?.hideSold ?? DEFAULT_HIDE_SOLD)
  const [negotiableOnly, setNegotiableOnly] = useState(initialFilters?.negotiableOnly ?? DEFAULT_NEGOTIABLE_ONLY)
  const [selectedBand, setSelectedBand] = useState<number | null>(initialFilters?.selectedBand ?? DEFAULT_SELECTED_BAND)
  const activeListingId = getActiveListingId(usePathname())

  // Listings are fetched page-by-page from /api/products/[id]/listings
  // (see listingsFilters.ts's paginateListings) - same infinite-scroll shape
  // as ProductListClient.tsx's products fetch. `listings` only ever holds the
  // pages loaded so far; matchedCount/allIds come from the server on every
  // fetch and always describe the *entire* filtered/sorted set.
  const [listings, setListings] = useState(initialListings)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [matchedCount, setMatchedCount] = useState(initialMatchedCount)
  const [allIds, setAllIds] = useState(initialAllIds)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const fetchPage = useCallback(
    async (filters: ListingsFilters, offset: number, replace: boolean) => {
      setLoading(true)
      const params = new URLSearchParams(buildListingsQueryString(filters))
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
      fetchPage({ view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand }, 0, true)
    }, 300)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand, fetchPage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading)
          fetchPage({ view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand }, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextOffset, loading, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand, fetchPage])

  // Carried on every listing link as `?back=` so that link's "Back to
  // {product}" button (ListingDetailContent) returns here with these same
  // filters applied, instead of the product page resetting to its defaults.
  const backQueryString = buildListingsQueryString({ view, sortKey, listedWithinDays, hideSold, negotiableOnly, selectedBand })
  const listingHref = (listingId: string) => (backQueryString ? `/listings/${listingId}?back=${encodeURIComponent(backQueryString)}` : `/listings/${listingId}`)

  const filtersActive =
    listedWithinDays !== DEFAULT_LISTED_WITHIN_DAYS ||
    hideSold !== DEFAULT_HIDE_SOLD ||
    negotiableOnly !== DEFAULT_NEGOTIABLE_ONLY ||
    selectedBand !== DEFAULT_SELECTED_BAND

  function clearFilters() {
    setListedWithinDays(DEFAULT_LISTED_WITHIN_DAYS)
    setHideSold(DEFAULT_HIDE_SOLD)
    setNegotiableOnly(DEFAULT_NEGOTIABLE_ONLY)
    setSelectedBand(DEFAULT_SELECTED_BAND)
  }

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

  return (
    <div>
      {discountBands.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
          {discountBands.map((band) => (
            <button
              key={band.bandFloor}
              className="mono"
              onClick={() => setSelectedBand((prev) => (prev === band.bandFloor ? null : band.bandFloor))}
              style={discountBandBadgeStyle(selectedBand === band.bandFloor)}
            >
              {band.bandFloor}-{band.bandFloor + 9}% off ×{band.count}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => setView('cards')}
          aria-pressed={view === 'cards'}
          style={toggleButtonStyle(view === 'cards')}
        >
          Cards
        </button>
        <button
          onClick={() => setView('list')}
          aria-pressed={view === 'list'}
          style={toggleButtonStyle(view === 'list')}
        >
          List
        </button>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} style={selectStyle}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>
        <select
          value={listedWithinDays}
          onChange={(e) => setListedWithinDays(Number(e.target.value))}
          style={selectStyle}
        >
          {LISTED_WITHIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Listed: {o.label}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.9em', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideSold} onChange={(e) => setHideSold(e.target.checked)} />
          Hide sold
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.9em', cursor: 'pointer' }}>
          <input type="checkbox" checked={negotiableOnly} onChange={(e) => setNegotiableOnly(e.target.checked)} />
          Negotiable only
        </label>
        {filtersActive && (
          <button onClick={clearFilters} style={toggleButtonStyle(false)}>
            Clear
          </button>
        )}
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
          {matchedCount} of {totalListingCount}
        </span>
      </div>

      {view === 'list' ? (
        <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--color-border)' }}>
              <th></th>
              <th>Title</th>
              <th>Condition</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr
                key={l.id}
                style={{
                  borderBottom: '1px solid var(--color-border)',
                  boxShadow: l.id === activeListingId ? 'inset 3px 0 0 0 var(--color-accent)' : undefined,
                  background: l.id === activeListingId ? 'var(--color-surface)' : undefined,
                }}
              >
                <td>
                  {l.primary_photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.primary_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                  ) : null}
                </td>
                <td>
                  <Link href={listingHref(l.id)}>{l.title}</Link>
                  {l.sold_at && <SoldBadge />}
                  <span style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                    <SaveButton listingId={l.id} productId={productId} initialSaved={l.is_saved} variant="icon" />
                  </span>
                </td>
                <td>{l.condition ?? '—'}</td>
                <td className="mono">
                  {formatListingPrice(l)}
                  {isListingPriceNegotiable(l.price_amount, l.price_review, l.discount_percent) && <NegotiableBadge />}
                  {l.is_repost && <RepostBadge />}
                  <DiscountBadge percent={l.discount_percent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
          {listings.map((l) => (
            <Link
              key={l.id}
              href={listingHref(l.id)}
              style={{
                display: 'block',
                background: 'var(--color-surface)',
                border: l.id === activeListingId ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                borderRadius: 8,
                overflow: 'hidden',
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)', position: 'relative' }}>
                {l.primary_photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.primary_photo_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : null}
                <div
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                  }}
                >
                  {l.sold_at && <SoldBadge />}
                  {isListingPriceNegotiable(l.price_amount, l.price_review, l.discount_percent) && <NegotiableBadge />}
                  {l.is_repost && <RepostBadge />}
                  <DiscountBadge percent={l.discount_percent} />
                </div>
                <div style={{ position: 'absolute', top: 6, left: 6 }}>
                  <SaveButton listingId={l.id} productId={productId} initialSaved={l.is_saved} variant="icon" />
                </div>
              </div>
              <div style={{ padding: 10 }}>
                <div style={{ fontSize: '0.9em' }}>{l.title}</div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
                  {l.condition ?? '—'}
                </div>
                <div className="mono" style={{ marginTop: 4 }}>
                  {formatListingPrice(l)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>}
      {!loading && nextOffset === null && listings.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!loading && listings.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No listings found.</p>}
    </div>
  )
}
