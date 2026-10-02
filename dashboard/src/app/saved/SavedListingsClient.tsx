'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { SavedListingSummary } from '@/lib/queries'
import SaveButton from '../SaveButton'

// No filters/search/pagination - saved lists are expected to stay small
// (a personal shortlist, not a mirror of the whole catalog), so a plain
// grid is enough. List is seeded from the server-rendered page and pruned
// locally on unsave (SaveButton's onToggle) rather than re-fetching.
export default function SavedListingsClient({ initialListings }: { initialListings: SavedListingSummary[] }) {
  const [listings, setListings] = useState(initialListings)

  function handleUnsave(id: string) {
    setListings((prev) => prev.filter((l) => l.id !== id))
  }

  if (listings.length === 0) {
    return <p style={{ color: 'var(--color-text-muted)' }}>No saved listings yet.</p>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
      {listings.map((l) => (
        <div
          key={l.id}
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <Link href={`/listings/${l.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
            <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)', position: 'relative' }}>
              {l.primary_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
                <img
                  src={l.primary_photo_url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : null}
            </div>
            <div style={{ padding: 10 }}>
              <div style={{ fontSize: '0.9em' }}>{l.title}</div>
              {l.base_model && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em', marginTop: 2 }}>
                  {l.base_model}
                  {l.variant_tier ? ` — ${l.variant_tier}` : ''}
                </div>
              )}
              <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
                {l.condition ?? '—'}
                {l.sold_at ? ' · Sold' : ''}
              </div>
              <div className="mono" style={{ marginTop: 4 }}>
                {l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : 'Price not listed'}
              </div>
            </div>
          </Link>
          <div style={{ padding: '0 10px 10px' }}>
            <SaveButton
              listingId={l.id}
              productId={l.product_id}
              initialSaved={true}
              onToggle={(saved) => {
                if (!saved) handleUnsave(l.id)
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
