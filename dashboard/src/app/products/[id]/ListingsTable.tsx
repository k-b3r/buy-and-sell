import Link from 'next/link'
import { isListingPriceNegotiable } from '@/lib/pricing'
import SaveButton from '../../SaveButton'
import { DiscountBadge, NegotiableBadge, RepostBadge, SoldBadge } from './ListingBadges'
import { formatListingPrice } from '@/lib/listingPrice'
import type { PaginatedListingSummary } from './listingsFilters'

export default function ListingsTable({
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
    <div style={{ overflowX: 'auto' }}>
      <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480 }}>
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
                  // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
                  <img src={l.primary_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                ) : null}
              </td>
              <td style={{ maxWidth: 260 }}>
                <Link
                  href={listingHref(l.id)}
                  style={{
                    display: 'inline-block',
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'middle',
                  }}
                >
                  {l.title}
                </Link>
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
                <DiscountBadge percent={l.discount_percent} reasoning={l.verification_reasoning} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
