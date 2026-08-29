'use client'

import { useState } from 'react'
import type { ProductNeedingReview, ProductPriceHistoryEntry } from '@/lib/queries'

const badgeStyle = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 8,
  fontSize: '0.7em',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-muted)',
} as const

const buttonStyle = {
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: '0.85em',
  border: '1px solid var(--color-border)',
  cursor: 'pointer',
} as const

const priceInputStyle = {
  width: 90,
  padding: '4px 6px',
  borderRadius: 4,
  fontSize: '0.85em',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
} as const

// '' means "leave blank" - distinct from 0, which would fail the route's
// positive-price validation anyway. Prefilled from whatever price already
// won NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL (possibly an automated
// source), so editing one field doesn't require retyping the other.
function initialPriceFields(product: ProductNeedingReview) {
  return {
    retailMin: product.new_price_low?.toString() ?? '',
    retailMax: product.new_price_high?.toString() ?? '',
    secondhandMin: product.secondhand_price_low?.toString() ?? '',
    secondhandMax: product.secondhand_price_high?.toString() ?? '',
  }
}

// Raw source string shown as-is (e.g. "manual_new_retail", "web_search") -
// per direct instruction (2026-08-29), no llm/api/computed relabeling, just
// keep it recognizable that manual entries say "manual".
function PriceHistoryList({ entries }: { entries: ProductPriceHistoryEntry[] }) {
  if (entries.length === 0) return <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)' }}>No history yet</div>

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.75em', color: 'var(--color-text-muted)' }}>
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.price_low != null && entry.price_high != null
            ? `₱${entry.price_low.toLocaleString()}–₱${entry.price_high.toLocaleString()}`
            : 'no price'}
          {' · '}
          <span className="mono">{entry.source}</span>
          {entry.condition && ` · ${entry.condition}`}
          {' · '}
          {new Date(entry.checked_at).toLocaleDateString()}
        </li>
      ))}
    </ul>
  )
}

function formatTrainedPrice(product: ProductNeedingReview): string | null {
  const e = product.enrichment
  if (!e || !e.has_trained_price_knowledge) return null
  const currency = e.trained_price_currency ?? ''
  if (e.trained_price_low != null && e.trained_price_high != null) {
    return `${currency} ${e.trained_price_low.toLocaleString()}-${e.trained_price_high.toLocaleString()}`.trim()
  }
  return null
}

// Removes the row from local state on success rather than an optimistic
// flip (unlike SaveButton.tsx's toggle) - both actions here are terminal
// resolutions of the needs_review state, there's nothing to revert *to*.
function ReviewRow({ product, onResolved }: { product: ProductNeedingReview; onResolved: (id: number) => void }) {
  const [loading, setLoading] = useState<'reviewed' | 'excluded' | 'prices' | null>(null)
  const [confirming, setConfirming] = useState<'reviewed' | 'excluded' | 'prices' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prices, setPrices] = useState(() => initialPriceFields(product))

  async function resolve(action: 'mark-reviewed' | 'exclude', kind: 'reviewed' | 'excluded') {
    setConfirming(null)
    setLoading(kind)
    setError(null)
    try {
      const res = await fetch(`/api/products/${product.id}/${action}`, { method: 'POST' })
      if (!res.ok) {
        setError('Failed - try again')
        return
      }
      onResolved(product.id)
    } catch {
      setError('Failed - try again')
    } finally {
      setLoading(null)
    }
  }

  // Saving a manual price also resolves the review (route pairs it with
  // markProductReviewed) - only kinds with both a min and max filled in get
  // sent, so leaving secondhand blank while only setting retail doesn't fire
  // a request that would fail the route's number validation.
  async function savePrices() {
    const requests: { kind: 'new' | 'secondhand'; priceLow: number; priceHigh: number }[] = []
    if (prices.retailMin.trim() && prices.retailMax.trim()) {
      requests.push({ kind: 'new', priceLow: Number(prices.retailMin), priceHigh: Number(prices.retailMax) })
    }
    if (prices.secondhandMin.trim() && prices.secondhandMax.trim()) {
      requests.push({ kind: 'secondhand', priceLow: Number(prices.secondhandMin), priceHigh: Number(prices.secondhandMax) })
    }
    if (requests.length === 0) {
      setError('Enter at least one min and max')
      return
    }
    if (requests.some((r) => !Number.isFinite(r.priceLow) || !Number.isFinite(r.priceHigh) || r.priceLow <= 0 || r.priceLow > r.priceHigh)) {
      setError('Min/max must be positive numbers with min ≤ max')
      return
    }

    setConfirming(null)
    setLoading('prices')
    setError(null)
    try {
      for (const body of requests) {
        const res = await fetch(`/api/products/${product.id}/manual-price`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          setError('Failed - try again')
          return
        }
      }
      onResolved(product.id)
    } catch {
      setError('Failed - try again')
    } finally {
      setLoading(null)
    }
  }

  const trainedPrice = formatTrainedPrice(product)
  const newHistory = product.price_history.filter((h) => h.kind === 'new')
  const secondhandHistory = product.price_history.filter((h) => h.kind === 'secondhand')

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          flexShrink: 0,
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--color-bg)',
        }}
      >
        {product.sample_photo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.sample_photo_url}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold' }}>{product.base_model}</div>
        {product.variant_tier && (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{product.variant_tier}</div>
        )}
        <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
          {product.category && (
            <span className="mono" style={badgeStyle}>
              {product.category}
            </span>
          )}
          {product.sub_category && (
            <span className="mono" style={badgeStyle}>
              {product.sub_category}
            </span>
          )}
          {product.enrichment?.confidence && (
            <span className="mono" style={badgeStyle}>
              confidence: {product.enrichment.confidence}
            </span>
          )}
          {product.enrichment?.is_specific_product === false && (
            <span className="mono" style={badgeStyle}>
              not specific
            </span>
          )}
        </div>

        {product.enrichment ? (
          <div style={{ marginTop: 8, fontSize: '0.9em' }}>
            <div>{product.enrichment.description}</div>
            <div style={{ color: 'var(--color-text-muted)', marginTop: 2 }}>{product.enrichment.value_drivers}</div>
            {trainedPrice && (
              <div style={{ color: 'var(--color-text-muted)', marginTop: 2 }}>Trained price knowledge: {trainedPrice}</div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: '0.9em', color: 'var(--color-text-muted)' }}>No enrichment data.</div>
        )}

        <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', marginBottom: 2 }}>Retail (new) ₱</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="number"
                placeholder="min"
                value={prices.retailMin}
                onChange={(e) => setPrices((p) => ({ ...p, retailMin: e.target.value }))}
                style={priceInputStyle}
              />
              <span style={{ color: 'var(--color-text-muted)' }}>-</span>
              <input
                type="number"
                placeholder="max"
                value={prices.retailMax}
                onChange={(e) => setPrices((p) => ({ ...p, retailMax: e.target.value }))}
                style={priceInputStyle}
              />
            </div>
            <div style={{ marginTop: 4 }}>
              <PriceHistoryList entries={newHistory} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', marginBottom: 2 }}>Secondhand ₱</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="number"
                placeholder="min"
                value={prices.secondhandMin}
                onChange={(e) => setPrices((p) => ({ ...p, secondhandMin: e.target.value }))}
                style={priceInputStyle}
              />
              <span style={{ color: 'var(--color-text-muted)' }}>-</span>
              <input
                type="number"
                placeholder="max"
                value={prices.secondhandMax}
                onChange={(e) => setPrices((p) => ({ ...p, secondhandMax: e.target.value }))}
                style={priceInputStyle}
              />
            </div>
            <div style={{ marginTop: 4 }}>
              <PriceHistoryList entries={secondhandHistory} />
            </div>
          </div>
          {confirming === 'prices' ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85em' }}>
              Save these prices?
              <button onClick={savePrices} disabled={loading !== null} style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-bg)', borderColor: 'var(--color-accent)' }}>
                {loading === 'prices' ? 'Saving...' : 'Yes'}
              </button>
              <button onClick={() => setConfirming(null)} disabled={loading !== null} style={{ ...buttonStyle, background: 'transparent', color: 'var(--color-text)' }}>
                No
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming('prices')}
              disabled={loading !== null || confirming !== null}
              style={{ ...buttonStyle, background: 'transparent', color: 'var(--color-text)' }}
            >
              Save prices
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          {confirming === 'reviewed' ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85em' }}>
              Mark reviewed?
              <button onClick={() => resolve('mark-reviewed', 'reviewed')} disabled={loading !== null} style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-bg)', borderColor: 'var(--color-accent)' }}>
                {loading === 'reviewed' ? 'Marking...' : 'Yes'}
              </button>
              <button onClick={() => setConfirming(null)} disabled={loading !== null} style={{ ...buttonStyle, background: 'transparent', color: 'var(--color-text)' }}>
                No
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming('reviewed')}
              disabled={loading !== null || confirming !== null}
              style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-bg)', borderColor: 'var(--color-accent)' }}
            >
              Mark reviewed
            </button>
          )}
          {confirming === 'excluded' ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85em' }}>
              Exclude from price lookup?
              <button onClick={() => resolve('exclude', 'excluded')} disabled={loading !== null} style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-bg)', borderColor: 'var(--color-accent)' }}>
                {loading === 'excluded' ? 'Excluding...' : 'Yes'}
              </button>
              <button onClick={() => setConfirming(null)} disabled={loading !== null} style={{ ...buttonStyle, background: 'transparent', color: 'var(--color-text)' }}>
                No
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming('excluded')}
              disabled={loading !== null || confirming !== null}
              style={{ ...buttonStyle, background: 'transparent', color: 'var(--color-text)' }}
            >
              Exclude from price lookup
            </button>
          )}
          {error && <span style={{ color: 'var(--color-signal)', fontSize: '0.85em' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}

export default function NeedsReviewClient({ initialProducts }: { initialProducts: ProductNeedingReview[] }) {
  const [products, setProducts] = useState(initialProducts)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
      {products.map((p) => (
        <ReviewRow key={p.id} product={p} onResolved={(id) => setProducts((prev) => prev.filter((x) => x.id !== id))} />
      ))}
    </div>
  )
}
