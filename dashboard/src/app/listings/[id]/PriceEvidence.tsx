import Link from 'next/link'
import type { ComparableListing } from '@/lib/queries'

function EvidenceRow({ listing, dateLabel }: { listing: ComparableListing; dateLabel: string }) {
  return (
    <Link
      href={`/listings/${listing.listing_id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 0',
        color: 'inherit',
        textDecoration: 'none',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--color-bg)',
        }}
      >
        {listing.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
          <img
            src={listing.photo_url}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {listing.title}
        </div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.75em' }}>
          {dateLabel} {listing.date ? new Date(listing.date).toLocaleDateString() : ''}
        </div>
      </div>
      <div className="mono" style={{ fontSize: '0.85em', flexShrink: 0 }}>
        ₱{listing.price_amount.toLocaleString()}
      </div>
    </Link>
  )
}

function EvidenceSection({
  title,
  listings,
  dateLabel,
}: {
  title: string
  listings: ComparableListing[]
  dateLabel: string
}) {
  if (listings.length === 0) return null

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em', marginBottom: 4 }}>{title}</div>
      {listings.map((l) => (
        <EvidenceRow key={l.listing_id} listing={l} dateLabel={dateLabel} />
      ))}
    </div>
  )
}

// The reference-price line in the info column ("vs typical ₱X for this
// product") is a single number - this (the layout's third column) shows the
// actual listings that number came from, same distinction /deals'
// sold_comps/peer_listings tiers make. Both
// sections are independent (a listing can have real sold comps AND active
// peers) rather than only showing whichever tier "won" the reference price.
//
// Defaults guard against a real prod crash (confirmed live 2026-09-02):
// getListingDetail is wrapped in unstable_cache, which persists across
// deploys - a listing cached before this field existed comes back with
// recentSales/similarListings undefined until its 5min TTL expires, not
// just in some hypothetical caller.
export default function PriceEvidence({
  recentSales = [],
  similarListings = [],
}: {
  recentSales?: ComparableListing[]
  similarListings?: ComparableListing[]
}) {
  if (recentSales.length === 0 && similarListings.length === 0) return null

  return (
    <div>
      <EvidenceSection title="Based on recent sales" listings={recentSales} dateLabel="Sold" />
      <EvidenceSection title="Based on similar listings" listings={similarListings} dateLabel="Listed" />
    </div>
  )
}
