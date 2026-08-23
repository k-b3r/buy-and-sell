'use client'

import { useState, type CSSProperties } from 'react'
import Link from 'next/link'
import type { ProductListingSummary } from '@/lib/queries'

type View = 'list' | 'cards'

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

const negotiableBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  border: '1px solid var(--color-accent)',
  color: 'var(--color-accent)',
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
function formatListingPrice(l: ProductListingSummary): string {
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

type SortKey = 'discount_desc' | 'discount_asc' | 'price_asc' | 'price_desc' | 'listed_newest' | 'listed_oldest'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'discount_desc', label: 'Discount: high to low' },
  { value: 'discount_asc', label: 'Discount: low to high' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'listed_newest', label: 'Listed: newest first' },
  { value: 'listed_oldest', label: 'Listed: oldest first' },
]

// Nulls always sort last, regardless of direction - a listing with no
// discount/date data shouldn't jump to the front just because "low to high"
// treats null as 0.
function compareNullableNumbers(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

function sortListings(listings: ProductListingSummary[], sortKey: SortKey): ProductListingSummary[] {
  const sorted = [...listings]
  switch (sortKey) {
    case 'discount_desc':
      return sorted.sort((a, b) => compareNullableNumbers(a.discount_percent, b.discount_percent, -1))
    case 'discount_asc':
      return sorted.sort((a, b) => compareNullableNumbers(a.discount_percent, b.discount_percent, 1))
    case 'price_asc':
      return sorted.sort((a, b) => compareNullableNumbers(a.price_amount, b.price_amount, 1))
    case 'price_desc':
      return sorted.sort((a, b) => compareNullableNumbers(a.price_amount, b.price_amount, -1))
    case 'listed_newest':
      return sorted.sort((a, b) => compareNullableNumbers(a.listed_at ? Date.parse(a.listed_at) : null, b.listed_at ? Date.parse(b.listed_at) : null, -1))
    case 'listed_oldest':
      return sorted.sort((a, b) => compareNullableNumbers(a.listed_at ? Date.parse(a.listed_at) : null, b.listed_at ? Date.parse(b.listed_at) : null, 1))
  }
}

const LISTED_WITHIN_OPTIONS = [
  { value: 0, label: 'Any time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
]

function filterListings(listings: ProductListingSummary[], listedWithinDays: number, hideSold: boolean): ProductListingSummary[] {
  return listings.filter((l) => {
    if (hideSold && l.sold_at) return false
    if (listedWithinDays > 0) {
      if (!l.listed_at) return false
      const cutoff = Date.now() - listedWithinDays * 24 * 60 * 60 * 1000
      if (Date.parse(l.listed_at) < cutoff) return false
    }
    return true
  })
}

const selectStyle: CSSProperties = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: '0.9em',
}

export default function ListingsView({ listings }: { listings: ProductListingSummary[] }) {
  const [view, setView] = useState<View>('cards')
  const [sortKey, setSortKey] = useState<SortKey>('discount_desc')
  const [listedWithinDays, setListedWithinDays] = useState(0)
  const [hideSold, setHideSold] = useState(false)

  const visibleListings = sortListings(filterListings(listings, listedWithinDays, hideSold), sortKey)

  return (
    <div>
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
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
          {visibleListings.length} of {listings.length}
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
            {visibleListings.map((l) => (
              <tr key={l.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td>
                  {l.primary_photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.primary_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                  ) : null}
                </td>
                <td>
                  <Link href={`/listings/${l.id}`}>{l.title}</Link>
                  {l.sold_at && <SoldBadge />}
                </td>
                <td>{l.condition ?? '—'}</td>
                <td className="mono">
                  {formatListingPrice(l)}
                  {l.price_review?.is_negotiable && <NegotiableBadge />}
                  <DiscountBadge percent={l.discount_percent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
          {visibleListings.map((l) => (
            <Link
              key={l.id}
              href={`/listings/${l.id}`}
              style={{
                display: 'block',
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                overflow: 'hidden',
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)' }}>
                {l.primary_photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.primary_photo_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : null}
              </div>
              <div style={{ padding: 10 }}>
                <div style={{ fontSize: '0.9em' }}>
                  {l.title}
                  {l.sold_at && <SoldBadge />}
                </div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
                  {l.condition ?? '—'}
                </div>
                <div className="mono" style={{ marginTop: 4 }}>
                  {formatListingPrice(l)}
                  {l.price_review?.is_negotiable && <NegotiableBadge />}
                  <DiscountBadge percent={l.discount_percent} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
