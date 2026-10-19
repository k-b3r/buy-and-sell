import type { DbClient } from '../../../platform/storage'
import type { DiscountCheckListing, DiscountPolicyThresholds, NewDiscountNotification, PriceRange } from '../types'
import { getProductCleanMedian } from '../store/comparables'
import { DEFAULT_DISCOUNT_POLICY } from '../domain/discount-policy'
import { decideDiscount, isCheckablePrice, pickReferencePrice } from '../domain/discount-decision'

// decideListingDiscount's fallback reference when real secondhand market data
// isn't available yet: the same peer median the deals page uses.
async function getDiscountPeerMedian(db: DbClient, productId: number): Promise<number | null> {
  const median = await getProductCleanMedian(db, productId, { scope: 'peer' })
  return median?.medianPrice ?? null
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
// Priority and thresholds live in domain/discount-decision.ts.
export async function decideListingDiscount(
  db: DbClient,
  listing: DiscountCheckListing,
  pricing: { retail: PriceRange | null; secondhand: PriceRange | null },
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<NewDiscountNotification | null> {
  const { priceAmount, productId } = listing
  if (!isCheckablePrice(priceAmount, thresholds)) return null

  const picked = pickReferencePrice(listing.condition, pricing)
  const referencePrice = picked === 'peer' ? await getDiscountPeerMedian(db, productId) : picked
  return decideDiscount(listing, priceAmount, referencePrice, thresholds)
}
