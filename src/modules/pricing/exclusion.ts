import type { DbClient } from '../../platform/storage'
import type { PriceExclusionReason } from './types'
import { deleteExclusionOverride, excludeFromPricing } from './store/exclusion'

// Needs-review page's alternative to markProductReviewed: a human looked and
// agrees with Groq's low-confidence hunch that this isn't a real priceable
// product. Callers validate the reason at the boundary (priceExclusionReasonSchema).
export async function excludeProductFromReview(
  db: DbClient,
  productId: number,
  reason: PriceExclusionReason,
): Promise<void> {
  // An explicit human exclusion wins over an earlier human include.
  await deleteExclusionOverride(db, productId)
  await excludeFromPricing(db, { productId }, reason, { resolveReview: true })
}
