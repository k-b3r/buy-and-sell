import { formatListingPrice } from '@/lib/listingPrice'
import { isListingPriceNegotiable } from '@/lib/shared.generated'
import type { ListingDetail } from '@/lib/queries'
import InfoTooltip from '../../InfoTooltip'

export default function ListingPriceSummary({ listing }: { listing: ListingDetail }) {
  return (
    <>
      <p className="mono" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
        {formatListingPrice(listing, 'Price not listed')}
        {isListingPriceNegotiable(listing.price_amount, listing.price_review, listing.discount_percent) && (
          <span
            style={{
              display: 'inline-block',
              marginLeft: 12,
              padding: '2px 10px',
              borderRadius: 12,
              fontSize: '0.5em',
              verticalAlign: 'middle',
              border: '1px solid var(--color-accent)',
              color: 'var(--color-accent)',
            }}
          >
            Negotiable
          </span>
        )}
        {listing.discount_percent !== null && listing.discount_percent !== 0 && (
          <span
            style={{
              display: 'inline-block',
              marginLeft: 12,
              padding: '2px 10px',
              borderRadius: 12,
              fontSize: '0.5em',
              verticalAlign: 'middle',
              background: listing.discount_percent > 0 ? 'var(--color-signal)' : 'var(--color-text-muted)',
              color: 'var(--color-bg)',
            }}
          >
            {listing.discount_percent > 0
              ? `${listing.discount_percent}% below avg`
              : `${Math.abs(listing.discount_percent)}% above avg`}
          </span>
        )}
        {listing.verification_reasoning && (
          <InfoTooltip
            text={listing.verification_reasoning}
            style={{ marginLeft: 6, fontSize: '0.6em', verticalAlign: 'middle', color: 'var(--color-text-muted)' }}
          />
        )}
      </p>
      {listing.reference_price !== null && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: -8 }}>
          vs typical ₱{listing.reference_price.toLocaleString()} for this product (outliers/placeholders excluded)
        </p>
      )}
    </>
  )
}
