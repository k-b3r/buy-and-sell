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

export default function ListingsView({ listings }: { listings: ProductListingSummary[] }) {
  const [view, setView] = useState<View>('cards')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
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
          {listings.map((l) => (
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
