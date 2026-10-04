import Link from 'next/link'
import { isListingPriceNegotiable } from '@/lib/pricing'
import SaveButton from '../../SaveButton'
import { DiscountBadge, NegotiableBadge, RepostBadge, SoldBadge } from './ListingBadges'
import { formatListingPrice } from '@/lib/listingPrice'
import type { PaginatedListingSummary } from './listingsFilters'

export default function ListingsGrid({
  listings,
  activeListingId,
  productId,
  listingHref,
}: {
  listings: PaginatedListingSummary[]
  activeListingId: string | null
  productId: number
  listingHref: (listingId: string) => string
}) {
  return (
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
              // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
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
              <DiscountBadge percent={l.discount_percent} reasoning={l.verification_reasoning} />
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
  )
}
