import { useState } from 'react'
import type { ProductNeedingReview } from '@/lib/queries'
import ConfirmAction from './ConfirmAction'
import PriceRangeField from './PriceRangeField'
import ProductReviewSummary from './ProductReviewSummary'
import { buildManualPriceRequests, initialPriceFields } from './reviewPrices'

type ReviewAction = 'reviewed' | 'excluded' | 'prices'

// Removes the row from local state on success rather than an optimistic
// flip (unlike SaveButton.tsx's toggle) - both actions here are terminal
// resolutions of the needs_review state, there's nothing to revert *to*.
export default function ReviewRow({
  product,
  onResolved,
}: {
  product: ProductNeedingReview
  onResolved: (id: number) => void
}) {
  const [loading, setLoading] = useState<ReviewAction | null>(null)
  const [confirming, setConfirming] = useState<ReviewAction | null>(null)
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
  // markProductReviewed).
  async function savePrices() {
    const built = buildManualPriceRequests(prices)
    if ('error' in built) {
      setError(built.error)
      return
    }

    setConfirming(null)
    setLoading('prices')
    setError(null)
    try {
      for (const body of built.requests) {
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

  const actionState = { confirming, loading, onConfirmingChange: setConfirming }

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
          // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
          <img
            src={product.sample_photo_url}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <ProductReviewSummary product={product} />

        <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <PriceRangeField
            label="Retail (new) ₱"
            min={prices.retailMin}
            max={prices.retailMax}
            onMinChange={(value) => setPrices((p) => ({ ...p, retailMin: value }))}
            onMaxChange={(value) => setPrices((p) => ({ ...p, retailMax: value }))}
            history={product.price_history.filter((h) => h.kind === 'new')}
          />
          <PriceRangeField
            label="Secondhand ₱"
            min={prices.secondhandMin}
            max={prices.secondhandMax}
            onMinChange={(value) => setPrices((p) => ({ ...p, secondhandMin: value }))}
            onMaxChange={(value) => setPrices((p) => ({ ...p, secondhandMax: value }))}
            history={product.price_history.filter((h) => h.kind === 'secondhand')}
          />
          <ConfirmAction
            {...actionState}
            kind="prices"
            onConfirm={savePrices}
            label="Save prices"
            prompt="Save these prices?"
            busyLabel="Saving..."
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <ConfirmAction
            {...actionState}
            kind="reviewed"
            onConfirm={() => resolve('mark-reviewed', 'reviewed')}
            label="Mark reviewed"
            prompt="Mark reviewed?"
            busyLabel="Marking..."
            primary
          />
          <ConfirmAction
            {...actionState}
            kind="excluded"
            onConfirm={() => resolve('exclude', 'excluded')}
            label="Exclude from price lookup"
            prompt="Exclude from price lookup?"
            busyLabel="Excluding..."
          />
          {error && <span style={{ color: 'var(--color-signal)', fontSize: '0.85em' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}
