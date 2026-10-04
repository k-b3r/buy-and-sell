import type { ListingDetail } from '@/lib/queries'
import ListingCarousel from './ListingCarousel'
import RefreshButton from './RefreshButton'
import BackLink from '../../BackLink'
import { marketplaceButtonStyle } from '../../marketplaceButtonStyle'
import FacebookIcon from '../../FacebookIcon'
import SaveButton from '../../SaveButton'
import PriceEvidence from './PriceEvidence'
import ListingFacts from './ListingFacts'
import ListingPriceSummary from './ListingPriceSummary'

// showBackLink is off in the modal variant - closing the modal already
// returns to the product page it was opened from, so a link doing the same
// thing would be redundant (and would trigger a full navigation instead of
// just dismissing the overlay).
export default function ListingDetailContent({
  listing,
  showBackLink = true,
  back,
}: {
  listing: ListingDetail
  showBackLink?: boolean
  // Raw querystring ListingsView's listing links carried (sort/hide-sold/
  // discount-band/etc. - see parseListingsFilters), so "Back to {product}"
  // returns to that exact filtered view instead of resetting to defaults.
  back?: string
}) {
  return (
    <div className="listing-detail-container">
      {showBackLink && (
        <p>
          {listing.product_id ? (
            <BackLink
              href={back ? `/products/${listing.product_id}?${back}` : `/products/${listing.product_id}`}
              label={`Back to ${listing.base_model}`}
            />
          ) : (
            <BackLink href="/" label="Back to products" />
          )}
        </p>
      )}

      <div className="listing-detail-layout">
        <div className="listing-detail-media">
          <ListingCarousel photoUrls={listing.photo_urls} title={listing.title} />
        </div>

        <div className="listing-detail-info">
          <h1 style={{ marginTop: 0 }}>
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

          <ListingPriceSummary listing={listing} />

          <p style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <RefreshButton listingId={listing.id} productId={listing.product_id} />
            <SaveButton listingId={listing.id} productId={listing.product_id} initialSaved={listing.is_saved} />
          </p>

          <ListingFacts listing={listing} />

          {listing.description && (
            <div className="listing-description">
              <h2>Description</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{listing.description}</p>
            </div>
          )}

          {showBackLink && (
            // Fixed to the viewport, not the modal box - Modal.tsx renders
            // its own copy of this button (anchored to its box instead) for
            // the modal variant, so it stays visually inside the modal
            // rather than floating over the backdrop at the screen's corner.
            <a
              href={`https://www.facebook.com/marketplace/item/${listing.id}/`}
              target="_blank"
              rel="noreferrer"
              aria-label="View on Marketplace"
              title="View on Marketplace"
              style={{ ...marketplaceButtonStyle, position: 'fixed', bottom: 24, right: 24, zIndex: 101 }}
            >
              <FacebookIcon />
            </a>
          )}
        </div>

        {listing.recent_sales?.length || listing.similar_listings?.length ? (
          <div className="listing-detail-evidence">
            <PriceEvidence recentSales={listing.recent_sales} similarListings={listing.similar_listings} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
