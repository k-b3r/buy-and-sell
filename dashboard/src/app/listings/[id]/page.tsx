import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPool } from '@/lib/db'
import { getListingDetail, isListingPriceNegotiable } from '@/lib/queries'
import type { ListingDetail } from '@/lib/queries'
import ListingCarousel from './ListingCarousel'

// price_review's range replaces the recorded price when it has a real read on
// it; a review row with no determinable price (both null) falls back to the
// recorded price, same as no review row at all.
function formatListingPrice(listing: ListingDetail): string {
  const review = listing.price_review
  if (review && (review.price_low !== null || review.price_high !== null)) {
    if (review.price_low === review.price_high) {
      return review.price_low !== null ? `₱${review.price_low.toLocaleString()}` : 'Price not listed'
    }
    if (review.price_low !== null && review.price_high !== null) {
      return `₱${review.price_low.toLocaleString()}–₱${review.price_high.toLocaleString()}`
    }
  }
  return listing.price_amount !== null ? `₱${listing.price_amount.toLocaleString()}` : 'Price not listed'
}

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const listing = await getListingDetail(getPool(), id)
  if (!listing) notFound()

  return (
    <div>
      <p>
        {listing.product_id ? (
          <Link href={`/products/${listing.product_id}`}>← Back to {listing.base_model}</Link>
        ) : (
          <Link href="/">← Back to products</Link>
        )}
      </p>

      <h1>
        {listing.title}
        {listing.sold_at && (
          <span
            style={{
              display: 'inline-block',
              marginLeft: 12,
              padding: '2px 10px',
              borderRadius: 12,
              fontSize: '0.6em',
              verticalAlign: 'middle',
              background: 'var(--color-text-muted)',
              color: 'var(--color-bg)',
            }}
          >
            Sold
          </span>
        )}
      </h1>

      <ListingCarousel photoUrls={listing.photo_urls} title={listing.title} />

      <p className="mono" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
        {formatListingPrice(listing)}
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
      </p>
      {listing.reference_price !== null && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: -8 }}>
          vs typical ₱{listing.reference_price.toLocaleString()} for this product (outliers/placeholders excluded)
        </p>
      )}

      <table cellPadding={4}>
        <tbody>
          {listing.variant_tier && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Variant</td>
              <td>{listing.variant_tier}</td>
            </tr>
          )}
          {listing.condition && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Condition</td>
              <td>{listing.condition}</td>
            </tr>
          )}
          {listing.location_city && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Location</td>
              <td>{listing.location_city}</td>
            </tr>
          )}
          {listing.listed_at && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Listed</td>
              <td>{new Date(listing.listed_at).toLocaleDateString()}</td>
            </tr>
          )}
          {listing.last_seen_at && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Last confirmed live</td>
              <td>{new Date(listing.last_seen_at).toLocaleDateString()}</td>
            </tr>
          )}
          {listing.sold_at && (
            <tr>
              <td style={{ color: 'var(--color-text-muted)' }}>Sold</td>
              <td>{new Date(listing.sold_at).toLocaleDateString()}</td>
            </tr>
          )}
        </tbody>
      </table>

      {listing.description && (
        <>
          <h2>Description</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{listing.description}</p>
        </>
      )}

      <p>
        <a href={`https://www.facebook.com/marketplace/item/${listing.id}/`} target="_blank" rel="noreferrer">
          View original on Facebook →
        </a>
      </p>
    </div>
  )
}
