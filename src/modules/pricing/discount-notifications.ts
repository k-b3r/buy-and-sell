import type { DbClient } from '../../platform/storage'
import type { DiscountPolicyThresholds, NewDiscountNotification, PriceRange } from './types'
import { isJunkPrice, isMagnitudeOutlier } from './clean-median'
import { getProductCleanMedian } from './store/comparables'
import { isNewCondition } from './price-rules'
import { DEFAULT_DISCOUNT_POLICY } from './discount-policy'

// decideListingDiscount's fallback reference when real secondhand market data
// isn't available yet: the same peer median the deals page uses.
async function getDiscountPeerMedian(db: DbClient, productId: number): Promise<number | null> {
  const median = await getProductCleanMedian(db, productId, { scope: 'peer' })
  return median?.medianPrice ?? null
}

export interface DiscountCheckListing {
  id: string
  productId: number
  condition: string | null
  priceAmount: number | null
}

// Real-market-price-first discount decision for a single listing, made in
// workers/extract-products/run.ts right after its product has (or already had)
// retail/secondhand pricing ensured - the "trigger is retail pricing
// becoming available" design (2026-08-31), replacing the old
// batch-of-siblings-only check that could never fire on a product's first
// listing. Reads only; returns the notification to insert, or null when the
// listing doesn't qualify. Split from insertDiscountNotifications so the
// caller can decide before its batch's product_ids are saved (peer median
// then excludes the batch's own listings) and insert only after the save.
//
// Priority: secondhand (real market data) for any non-"New" listing - only
// falls back to peer-comparison (median of this product's own listings)
// when secondhand isn't available yet. "New" listings always compare
// against retail; a "New" listing is never passed here without a retail
// price already in hand (see ensureProductPriced's exclude-on-retail-miss
// behavior - a product with no retail was already excluded before this
// function would ever be called).
export async function decideListingDiscount(
  db: DbClient,
  listing: DiscountCheckListing,
  pricing: { retail: PriceRange | null; secondhand: PriceRange | null },
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<NewDiscountNotification | null> {
  const { priceAmount, productId } = listing
  if (priceAmount === null || isJunkPrice(priceAmount)) return null
  if (priceAmount < thresholds.minPricePesos) return null

  let referencePrice: number | null
  if (isNewCondition(listing.condition)) {
    referencePrice = pricing.retail ? pricing.retail.low : null
  } else if (pricing.secondhand) {
    referencePrice = pricing.secondhand.low
  } else {
    referencePrice = await getDiscountPeerMedian(db, productId)
  }

  if (referencePrice === null || referencePrice <= 0) return null
  if (isMagnitudeOutlier(priceAmount, referencePrice)) return null

  const discountPercent = Math.round(((referencePrice - priceAmount) / referencePrice) * 100)
  const profitPesos = referencePrice - priceAmount
  if (discountPercent < thresholds.highDiscountThresholdPercent || profitPesos < thresholds.minProfitPesos) return null

  return { listingId: listing.id, productId, discountPercent, referencePrice }
}
