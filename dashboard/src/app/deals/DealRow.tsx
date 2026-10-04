import Link from 'next/link'
import type { DealListing, DealsConfidenceTier } from '@/lib/queries'
import SaveButton from '../SaveButton'

// Plain-language labels for the reference-price fallback chain (highest
// confidence first) - "sold_comps"/"peer_listings"/"llm_estimate" are the
// tier names used internally (getDeals, filters) but read as jargon on the
// page itself.
const TIER_LABELS: Record<DealsConfidenceTier, string> = {
  sold_comps: 'Based on recent sales',
  peer_listings: 'Based on similar listings',
  llm_estimate: 'AI estimate',
}

// Longer explanation for each tier, shown as a native tooltip on the badge -
// the short label alone doesn't say *why* one tier beats another.
const TIER_DESCRIPTIONS: Record<DealsConfidenceTier, string> = {
  sold_comps:
    "Median asking price of this product's listings that have actually sold - the strongest signal, though Facebook doesn't show the final agreed price.",
  peer_listings: 'Median asking price of other active listings for this product - nobody has paid this yet.',
  llm_estimate: "AI-researched price estimate - used when there aren't enough real listings to compare against.",
}

const TIER_COLORS: Record<DealsConfidenceTier, string> = {
  sold_comps: 'var(--color-signal)',
  peer_listings: '#60a5fa',
  llm_estimate: 'var(--color-text-muted)',
}

export default function DealRow({ deal }: { deal: DealListing }) {
  // Links into the same intercepted-route listing modal every other list
  // view uses (ListingsView.tsx, SavedListingsClient.tsx) instead of
  // straight out to Facebook - the modal has the FB link (and photo
  // carousel, description, condition, price review, verification notes)
  // already, so this is strictly more info than an external tab, without
  // losing the deals list underneath.
  const listingHref = `/listings/${deal.listing_id}`
  return (
    <Link href={listingHref} className="deal-row">
      <div style={{ flexShrink: 0 }}>
        <div style={{ width: 64, height: 64, borderRadius: 6, overflow: 'hidden', background: 'var(--color-bg)' }}>
          {deal.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
            <img
              src={deal.photo_url}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : null}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {deal.title}
        </div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
          {deal.base_model}
          {deal.variant_tier ? ` — ${deal.variant_tier}` : ''}
          {deal.category ? ` · ${deal.category}` : ''}
        </div>
        <div className="mono" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>₱{deal.ask_price.toLocaleString()}</span>
          {deal.reference_price !== null && (
            <span style={{ color: 'var(--color-text-muted)' }}>
              vs ₱{Math.round(deal.reference_price).toLocaleString()}
            </span>
          )}
          {deal.tier && (
            <span
              title={TIER_DESCRIPTIONS[deal.tier]}
              style={{
                padding: '1px 6px',
                borderRadius: 8,
                fontSize: '0.75em',
                background: TIER_COLORS[deal.tier],
                color: deal.tier === 'llm_estimate' ? 'var(--color-bg)' : '#000',
                cursor: 'help',
              }}
            >
              {TIER_LABELS[deal.tier]}
              {deal.comp_count !== null && ` (${deal.comp_count})`}
            </span>
          )}
        </div>
      </div>
      <div className="deal-row-stats">
        {deal.profit_pesos !== null ? (
          <div className="mono" style={{ fontWeight: 'bold', fontSize: '1.1em', color: 'var(--color-signal)' }}>
            +₱{Math.round(deal.profit_pesos).toLocaleString()}
          </div>
        ) : (
          <div className="mono" style={{ color: 'var(--color-text-muted)' }}>
            No estimate
          </div>
        )}
        {deal.discount_percent !== null && (
          <div className="mono" style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
            {deal.discount_percent}% off
          </div>
        )}
        {deal.days_listed !== null && (
          <div className="mono" style={{ fontSize: '0.8em', color: 'var(--color-text-muted)' }}>
            {deal.days_listed === 1 ? '1 day listed' : `${deal.days_listed} days listed`}
          </div>
        )}
        {/* Est. days-to-sell (median sold_at - listed_at per product) - shipped
            as a placeholder per user decision (2026-09-02): the query doesn't
            exist yet, and blocking the whole page on it wasn't worth it. */}
        <div className="mono" style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', opacity: 0.6 }}>
          Days-to-sell: coming soon
        </div>
        <div style={{ marginTop: 6 }}>
          <SaveButton
            listingId={deal.listing_id}
            productId={deal.product_id}
            initialSaved={deal.is_saved}
            variant="icon"
          />
        </div>
      </div>
    </Link>
  )
}
