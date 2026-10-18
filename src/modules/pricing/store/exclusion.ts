import type { DbClient, QueryClient } from '../../../platform/storage'
import { LOOKUP_OUTCOME_REASONS } from '../domain/exclusion-reasons'
import type { PriceExclusionReason } from '../types'

// The one owner of the products.price_lookup_excluded write: every write of
// the flag goes through this file, with a reason from exclusion-reasons.ts.

// Automatic exclusion writes skip products a human included over a judgment
// (price_exclusion_overrides, BUY-36).
const NOT_OVERRIDDEN = 'NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = products.id)'

export type ExclusionTarget = { productId: number } | { baseModels: string[] }

// Nothing un-excludes a product automatically; includeInPricing is the human undo. By product id when
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
  const resolveReviewSql = options.resolveReview ? ', price_lookup_review_status = NULL' : ''
  const whereSql = 'productId' in target ? 'id = $2' : 'base_model = ANY($2)'
  await db.query(
    `UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1${resolveReviewSql} WHERE ${whereSql} AND ${NOT_OVERRIDDEN}`,
    [reason, 'productId' in target ? target.productId : target.baseModels],
  )
}

// Distinct base_model values not yet excluded, alphabetical: the pool the
// offline generic-product report scans.
export async function getUnexcludedBaseModels(db: DbClient): Promise<string[]> {
  const result = (await db.query(
    `SELECT DISTINCT base_model FROM products WHERE NOT price_lookup_excluded ORDER BY base_model`,
    [],
  )) as { rows: { base_model: string }[] }
  return result.rows.map((r) => r.base_model)
}

// Drops a human's earlier include, so an explicit exclusion wins over it.
export async function deleteExclusionOverride(db: DbClient, productId: number): Promise<void> {
  await db.query('DELETE FROM price_exclusion_overrides WHERE product_id = $1', [productId])
}

// The human undo (product page). A lookup-outcome reason is cleared so price
// lookup retries the product; a judgment reason is cleared and recorded as an
// override so the automatic writers leave it alone. A product that isn't
// excluded is left untouched. One statement, so the override and the flag
// can't disagree.
export async function includeInPricing(db: DbClient, productId: number): Promise<void> {
  await db.query(
    `WITH target AS (
       SELECT id, price_lookup_excluded_reason AS reason FROM products WHERE id = $1 AND price_lookup_excluded
     ), override AS (
       INSERT INTO price_exclusion_overrides (product_id, previous_reason)
       SELECT id, COALESCE(reason, 'unknown') FROM target WHERE reason IS NULL OR NOT (reason = ANY($2))
       ON CONFLICT (product_id) DO UPDATE SET previous_reason = EXCLUDED.previous_reason, overridden_at = now()
     )
     UPDATE products SET price_lookup_excluded = false, price_lookup_excluded_reason = NULL
     FROM target WHERE products.id = target.id`,
    [productId, [...LOOKUP_OUTCOME_REASONS]],
  )
}

// A human's "no exclusion needed" on a needs_review product: clears the flag and
// stamps the dismissal so applyEligibilityFromEnrichment won't re-flag it. Same
// write as catalog's markProductReviewed, kept here so pricing doesn't import catalog.
export async function dismissReview(db: QueryClient, productId: number): Promise<void> {
  await db.query(
    `UPDATE products SET price_lookup_review_status = NULL, price_lookup_review_dismissed_at = now() WHERE id = $1`,
    [productId],
  )
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
       AND NOT p.price_lookup_excluded
       AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = p.id)`,
    [],
  )
  await db.query(
    `UPDATE products p SET price_lookup_review_status = 'needs_review'
     FROM product_enrichment e
     WHERE e.product_id = p.id
       AND e.confidence = 'low'
       AND NOT p.price_lookup_excluded
       AND p.price_lookup_review_status IS DISTINCT FROM 'needs_review'
       AND p.price_lookup_review_dismissed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = p.id)`,
    [],
  )
}

export interface ExclusionReasonCount {
  reason: string
  count: number
  // true: a failed price search, so including the product retries the lookup.
  retry: boolean
}

// Excluded view's reason groups, biggest first.
export async function getExclusionSummary(db: QueryClient): Promise<ExclusionReasonCount[]> {
  const result = (await db.query(
    `SELECT COALESCE(price_lookup_excluded_reason, 'unknown') AS reason, count(*)::int AS count,
            COALESCE(price_lookup_excluded_reason = ANY($1), false) AS retry
     FROM products WHERE price_lookup_excluded
     GROUP BY 1, 3 ORDER BY 2 DESC, 1`,
    [[...LOOKUP_OUTCOME_REASONS]],
  )) as { rows: ExclusionReasonCount[] }
  return result.rows
}

export interface ExcludedProduct {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
}

const EXCLUDED_PAGE_SIZE = 50

// One reason's excluded products, most listings first: the ones whose
// missing price hides the most.
export async function getExcludedProducts(
  db: QueryClient,
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, count(l.id)::int AS listing_count
     FROM products p LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded AND COALESCE(p.price_lookup_excluded_reason, 'unknown') = $1
     GROUP BY p.id ORDER BY listing_count DESC, p.base_model
     LIMIT $2 OFFSET $3`,
    [reason, options.limit ?? EXCLUDED_PAGE_SIZE, options.offset ?? 0],
  )) as { rows: ExcludedProduct[] }
  return result.rows
}
