import Link from 'next/link'
import type { ProductSummary } from '@/lib/queries'
import { exclusionLabel } from '@/lib/exclusionReasons'

// listQueryString rides along as `?from=` so the product page's "Back to
// products" button returns to the filtered list it came from. showExclusion
// is pricing.exclusions_ui_enabled (BUY-36).
export default function ProductCard({
  p,
  listQueryString,
  showExclusion = false,
}: {
  p: ProductSummary
  listQueryString: string
  showExclusion?: boolean
}) {
  return (
    <Link
      href={listQueryString ? `/products/${p.id}?from=${encodeURIComponent(listQueryString)}` : `/products/${p.id}`}
      style={{
        display: 'block',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        overflow: 'hidden',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)', position: 'relative' }}>
        {p.sample_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
          <img
            src={p.sample_photo_url}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null}
        <span
          className="mono"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            padding: '2px 8px',
            borderRadius: 12,
            fontSize: '0.75em',
            background: 'var(--color-overlay-strong)',
            color: '#fff',
          }}
        >
          {p.listing_count} listings
        </span>
        {p.discount_bands.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              alignItems: 'flex-end',
            }}
          >
            {p.discount_bands.map((band) => (
              <div
                key={band.bandFloor}
                className="mono"
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: '0.75em',
                  fontWeight: 'bold',
                  background: 'var(--color-signal)',
                  color: 'var(--color-bg)',
                }}
              >
                {band.bandFloor}-{band.bandFloor + 9}% {band.count}x
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: 12 }}>
        <div>
          <div style={{ fontWeight: 'bold' }}>{p.base_model}</div>
          {p.variant_tier && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{p.variant_tier}</div>
          )}
          {p.sub_category && (
            <span
              className="mono"
              style={{
                display: 'inline-block',
                marginTop: 4,
                padding: '1px 6px',
                borderRadius: 8,
                fontSize: '0.65em',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              {p.sub_category}
            </span>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="mono" style={{ fontSize: '0.9em' }}>
            {p.price_min !== null && p.price_max !== null
              ? `₱${p.price_min.toLocaleString()}–₱${p.price_max.toLocaleString()}`
              : 'No price data'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, marginTop: 6 }}>
            <ExclusionBadge reason={p.pricing_excluded_reason} show={showExclusion} />
            {p.price_avg !== null && (
              <span
                className="mono"
                style={{
                  padding: '1px 6px',
                  borderRadius: 8,
                  fontSize: '0.65em',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-muted)',
                }}
              >
                Avg ₱{Math.round(p.price_avg).toLocaleString()}
              </span>
            )}
            {p.secondhand_price_low !== null && p.secondhand_price_high !== null && (
              <span
                className="mono"
                style={{
                  padding: '1px 6px',
                  borderRadius: 8,
                  fontSize: '0.65em',
                  fontWeight: 'bold',
                  background: 'var(--color-signal)',
                  color: 'var(--color-bg)',
                }}
              >
                Used ₱{p.secondhand_price_low.toLocaleString()}–₱{p.secondhand_price_high.toLocaleString()}
              </span>
            )}
            {p.new_price_low !== null && p.new_price_high !== null && (
              <span
                className="mono"
                style={{
                  padding: '1px 6px',
                  borderRadius: 8,
                  fontSize: '0.65em',
                  // Fixed light blue, not var(--color-accent) - that
                  // swaps hue per theme, and black text needs a light
                  // fill regardless of theme to stay readable.
                  background: '#60a5fa',
                  color: '#000',
                }}
              >
                New ₱{p.new_price_low.toLocaleString()}–₱{p.new_price_high.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}

function ExclusionBadge({ reason, show }: { reason: string | null; show: boolean }) {
  if (!show || !reason) return null
  return (
    <span
      className="mono"
      title={`Pricing excluded: ${exclusionLabel(reason)}`}
      style={{
        padding: '1px 6px',
        borderRadius: 8,
        fontSize: '0.65em',
        background: 'var(--color-danger-bg)',
        color: 'var(--color-danger)',
      }}
    >
      No pricing: {exclusionLabel(reason)}
    </span>
  )
}
