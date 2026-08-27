import type { DbClient } from '../../platform/storage'
import type { EnrichmentCandidate } from '../../domains/marketplace'

export async function getEnrichmentCandidates(db: DbClient): Promise<EnrichmentCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category,
       COALESCE(
         (SELECT array_agg(DISTINCT COALESCE(p2.variant_tier, '(base, no variant)'))
          FROM products p2
          WHERE p2.base_model_normalized = p.base_model_normalized AND p2.id != p.id),
         ARRAY[]::text[]
       ) as sibling_variants
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE NOT EXISTS (SELECT 1 FROM product_enrichment e WHERE e.product_id = p.id)
     ORDER BY p.id`,
    [],
  )) as { rows: EnrichmentCandidate[] }
  return result.rows
}

export interface EnrichmentData {
  description: string
  valueDrivers: string
  hasTrainedPriceKnowledge: boolean
  trainedPriceLow: number | null
  trainedPriceHigh: number | null
  isSpecificProduct: boolean
  confidence: 'high' | 'low'
}

export async function upsertProductEnrichment(
  db: DbClient,
  productId: number,
  data: EnrichmentData,
  model: string,
): Promise<void> {
  const trainedPriceCurrency = data.trainedPriceLow !== null ? 'PHP' : null
  await db.query(
    `INSERT INTO product_enrichment
       (product_id, description, value_drivers, has_trained_price_knowledge, trained_price_low, trained_price_high, trained_price_currency, model, is_specific_product, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (product_id) DO UPDATE SET
       description = EXCLUDED.description,
       value_drivers = EXCLUDED.value_drivers,
       has_trained_price_knowledge = EXCLUDED.has_trained_price_knowledge,
       trained_price_low = EXCLUDED.trained_price_low,
       trained_price_high = EXCLUDED.trained_price_high,
       trained_price_currency = EXCLUDED.trained_price_currency,
       model = EXCLUDED.model,
       is_specific_product = EXCLUDED.is_specific_product,
       confidence = EXCLUDED.confidence,
       checked_at = now()`,
    [
      productId,
      data.description,
      data.valueDrivers,
      data.hasTrainedPriceKnowledge,
      data.trainedPriceLow,
      data.trainedPriceHigh,
      trainedPriceCurrency,
      model,
      data.isSpecificProduct,
      data.confidence,
    ],
  )
}

// The other half of eligibility gating alongside flag-price-ineligible's
// curated-list matching (products.ts's flagPriceLookupExcluded, called from
// flag-price-ineligible/storage.ts) - this is the automatic path, driven by
// product_enrichment.is_specific_product/confidence instead of a
// human-maintained list. high-confidence "not a real product" auto-excludes
// (reusing price_lookup_excluded, not a new column - same flag either writer
// sets); anything low-confidence goes to price_lookup_review_status instead
// of guessing. NOT p.price_lookup_excluded in both guards makes this
// idempotent to re-run every lap without clobbering a curated-list reason
// that already decided the product.
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
       AND p.price_lookup_review_status IS DISTINCT FROM 'needs_review'`,
    [],
  )
}
