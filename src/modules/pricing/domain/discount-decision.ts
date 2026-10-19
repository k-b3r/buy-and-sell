import type { DiscountCheckListing, DiscountPolicyThresholds, NewDiscountNotification, PriceRange } from '../types'
import { isJunkPrice, isMagnitudeOutlier } from './clean-median'
import { isNewCondition } from './price-rules'

// A listing price worth a discount check: present, not a junk placeholder and
// at or above the policy's price floor.
export function isCheckablePrice(
  priceAmount: number | null,
  thresholds: DiscountPolicyThresholds,
): priceAmount is number {
  return priceAmount !== null && !isJunkPrice(priceAmount) && priceAmount >= thresholds.minPricePesos
}

// Priority: secondhand (real market data) for any non-"New" listing - only
// falls back to peer-comparison (median of this product's own listings)
// when secondhand isn't available yet ('peer'). "New" listings always compare
// against retail; a "New" listing is never passed here without a retail
// price already in hand (see ensureProductPriced's exclude-on-retail-miss
// behavior - a product with no retail was already excluded before this
// function would ever be called).
export function pickReferencePrice(
  condition: string | null,
  pricing: { retail: PriceRange | null; secondhand: PriceRange | null },
): number | null | 'peer' {
  if (isNewCondition(condition)) return pricing.retail ? pricing.retail.low : null
  if (pricing.secondhand) return pricing.secondhand.low
  return 'peer'
}

// The discount decision once the reference price is known: the notification
// to insert, or null when the listing doesn't qualify.
export function decideDiscount(
  listing: DiscountCheckListing,
  priceAmount: number,
  referencePrice: number | null,
  thresholds: DiscountPolicyThresholds,
): NewDiscountNotification | null {
  if (referencePrice === null || referencePrice <= 0) return null
  if (isMagnitudeOutlier(priceAmount, referencePrice)) return null

  const discountPercent = Math.round(((referencePrice - priceAmount) / referencePrice) * 100)
  const profitPesos = referencePrice - priceAmount
  if (discountPercent < thresholds.highDiscountThresholdPercent || profitPesos < thresholds.minProfitPesos) return null

  return { listingId: listing.id, productId: listing.productId, discountPercent, referencePrice }
}
