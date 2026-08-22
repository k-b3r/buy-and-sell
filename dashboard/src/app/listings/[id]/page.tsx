import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPool } from '@/lib/db'
import { getListingDetail } from '@/lib/queries'
import ListingCarousel from './ListingCarousel'

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
        {listing.price_amount !== null ? `₱${listing.price_amount.toLocaleString()}` : 'Price not listed'}
      </p>

      <table cellPadding={4}>
        <tbody>
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
