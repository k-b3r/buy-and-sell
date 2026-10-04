import type { ListingDetail } from '@/lib/queries'

export default function ListingFacts({ listing }: { listing: ListingDetail }) {
  return (
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
  )
}
