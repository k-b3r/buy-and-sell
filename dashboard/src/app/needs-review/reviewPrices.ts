import type { ProductNeedingReview } from '../../lib/queries'

export interface PriceFields {
  retailMin: string
  retailMax: string
  secondhandMin: string
  secondhandMax: string
}

export interface ManualPriceRequest {
  kind: 'new' | 'secondhand'
  priceLow: number
  priceHigh: number
}

// '' means "leave blank" - distinct from 0, which would fail the route's
// positive-price validation anyway. Prefilled from whatever price already
// won NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL (possibly an automated
// source), so editing one field doesn't require retyping the other.
export function initialPriceFields(product: ProductNeedingReview): PriceFields {
  return {
    retailMin: product.new_price_low?.toString() ?? '',
    retailMax: product.new_price_high?.toString() ?? '',
    secondhandMin: product.secondhand_price_low?.toString() ?? '',
    secondhandMax: product.secondhand_price_high?.toString() ?? '',
  }
}

// Only kinds with both a min and max filled in get sent, so leaving
// secondhand blank while only setting retail doesn't fire a request that
// would fail the manual-price route's number validation.
export function buildManualPriceRequests(prices: PriceFields): { requests: ManualPriceRequest[] } | { error: string } {
  const requests: ManualPriceRequest[] = []
  if (prices.retailMin.trim() && prices.retailMax.trim()) {
    requests.push({ kind: 'new', priceLow: Number(prices.retailMin), priceHigh: Number(prices.retailMax) })
  }
  if (prices.secondhandMin.trim() && prices.secondhandMax.trim()) {
    requests.push({
      kind: 'secondhand',
      priceLow: Number(prices.secondhandMin),
      priceHigh: Number(prices.secondhandMax),
    })
  }
  if (requests.length === 0) {
    return { error: 'Enter at least one min and max' }
  }
  if (
    requests.some(
      (r) =>
        !Number.isFinite(r.priceLow) || !Number.isFinite(r.priceHigh) || r.priceLow <= 0 || r.priceLow > r.priceHigh,
    )
  ) {
    return { error: 'Min/max must be positive numbers with min ≤ max' }
  }
  return { requests }
}

export function formatTrainedPrice(product: ProductNeedingReview): string | null {
  const e = product.enrichment
  if (!e || !e.has_trained_price_knowledge) return null
  const currency = e.trained_price_currency ?? ''
  if (e.trained_price_low != null && e.trained_price_high != null) {
    return `${currency} ${e.trained_price_low.toLocaleString()}-${e.trained_price_high.toLocaleString()}`.trim()
  }
  return null
}
