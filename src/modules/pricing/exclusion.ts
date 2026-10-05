import type { DbClient } from '../../platform/storage'

// The one owner of products.price_lookup_excluded: every write of the flag
// goes through this file, with a reason from this list. The signals behind
// those reasons stay separate on purpose (they're genuinely different
// sources); only the write and its vocabulary converge here:
//   real_estate, too_generic, parts_accessory, service - text heuristic
//     (detectGenericBaseModel in generic-products.ts, applied live by
//     ensureProductPriced)
//     or the human-curated lists in ineligible-categories.ts
//   needs_component_pricing - human-curated (ineligible-categories.ts)
//   groq_generic - LLM judgment (applyEligibilityFromEnrichment below)
//   retail_not_found - no provider found a retail price (ensureProductPriced)
//   manual_review - a human excluded it from the needs-review page
// exa_no_result is retired (historical rows only).
const PRICE_EXCLUSION_REASONS = [
  'real_estate',
  'too_generic',
  'parts_accessory',
  'service',
  'needs_component_pricing',
  'groq_generic',
  'retail_not_found',
  'manual_review',
] as const

export type PriceExclusionReason = (typeof PRICE_EXCLUSION_REASONS)[number]

function isPriceExclusionReason(value: unknown): value is PriceExclusionReason {
  return (PRICE_EXCLUSION_REASONS as readonly unknown[]).includes(value)
}

export type ExclusionTarget = { productId: number } | { baseModels: string[] }

// Permanent: nothing un-excludes a product automatically. By product id when
// one specific product's search came up empty or a human decided; by
// base_model text for the curated lists (idempotent, safe to re-run as more
// junk turns up). resolveReview also clears a pending needs_review flag,
// since an exclusion is itself a resolution.
export async function excludeFromPricing(
  db: DbClient,
  target: ExclusionTarget,
  reason: PriceExclusionReason,
  options: { resolveReview?: boolean } = {},
): Promise<void> {
  const resolveReview = options.resolveReview ? ', price_lookup_review_status = NULL' : ''
  const where = 'productId' in target ? 'id = $2' : 'base_model = ANY($2)'
  await db.query(
    `UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1${resolveReview} WHERE ${where}`,
    [reason, 'productId' in target ? target.productId : target.baseModels],
  )
}

// Needs-review page's alternative to markProductReviewed: a human looked and
// agrees with Groq's low-confidence hunch that this isn't a real priceable
// product. reason arrives from the dashboard over RPC, so it's checked
// against the known reasons before it reaches the table.
export async function excludeProductFromReview(db: DbClient, productId: number, reason: unknown): Promise<void> {
  if (!isPriceExclusionReason(reason)) throw new Error(`unknown price exclusion reason: ${String(reason)}`)
  await excludeFromPricing(db, { productId }, reason, { resolveReview: true })
}

// The automatic, LLM-driven path alongside the curated lists:
// product_enrichment.is_specific_product/confidence instead of a
// human-maintained list. High-confidence "not a real product" auto-excludes;
// anything low-confidence goes to price_lookup_review_status instead of
// guessing. NOT p.price_lookup_excluded in both guards makes this idempotent
// to re-run every lap without clobbering a curated-list reason that already
// decided the product. price_lookup_review_dismissed_at guards the second
// UPDATE specifically - this whole function reruns every enrich-products
// lap, and confidence='low' never changes (a product is only ever enriched
// once), so without that guard a human's markProductReviewed resolution gets
// silently overwritten back to needs_review on the very next lap. Set-based
// (one UPDATE ... FROM over every enriched product), so it can't route
// through excludeFromPricing's per-target write.
export async function applyEligibilityFromEnrichment(db: DbClient): Promise<void> {
  await db.query(
    `UPDATE products p SET price_lookup_excluded = true, price_lookup_excluded_reason = 'groq_generic'
     FROM product_enrichment e
     WHERE e.product_id = p.id
       AND e.confidence = 'high'
       AND e.is_specific_product = false
       AND NOT p.price_lookup_excluded`,
    [],
  )
  await db.query(
    `UPDATE products p SET price_lookup_review_status = 'needs_review'
     FROM product_enrichment e
     WHERE e.product_id = p.id
       AND e.confidence = 'low'
       AND NOT p.price_lookup_excluded
       AND p.price_lookup_review_status IS DISTINCT FROM 'needs_review'
       AND p.price_lookup_review_dismissed_at IS NULL`,
    [],
  )
}
