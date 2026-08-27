import type { DbClient } from '../../../platform/storage'
import { normalizeBaseModel, normalizeVariantTier } from '../products'
import type { EnrichmentCandidate, EnrichmentData } from '../enrichment'

// category is only ever set at creation, same as base_model/variant_tier —
// dashboard browsing/filtering only, not re-classified on subsequent
// extraction passes that happen to match an existing product.
export async function findOrCreateProduct(
  db: DbClient,
  baseModel: string,
  variantTier: string | null,
  category: string | null = null,
): Promise<number> {
  const normalized = normalizeBaseModel(baseModel)
  const normalizedVariant = variantTier === null ? null : normalizeVariantTier(variantTier)

  const existing = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2`,
    [normalized, normalizedVariant],
  )) as { rows: { id: number }[] }
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = (await db.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier, variant_tier_normalized, category_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM categories WHERE name = $5)) RETURNING id`,
    [baseModel, normalized, variantTier, normalizedVariant, category],
  )) as { rows: { id: number }[] }
  return inserted.rows[0].id
}

// Assigns product_id to many listings in a single round trip instead of one UPDATE
// per listing — the per-listing version was the dominant cost of a Pass 1/2 run
// (each remote Postgres round trip to Neon dwarfs the batched Gemini calls).
export async function updateListingProductIds(
  db: DbClient,
  assignments: { id: string; productId: number }[],
): Promise<void> {
  if (assignments.length === 0) return

  const valuesSql = assignments.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::int)`).join(', ')
  const params = assignments.flatMap((a) => [a.id, a.productId])

  await db.query(
    `UPDATE listings SET product_id = data.product_id
     FROM (VALUES ${valuesSql}) AS data(id, product_id)
     WHERE listings.id = data.id`,
    params,
  )
}

export interface ExtractionCandidate {
  id: string
  title: string
  description: string | null
}

export async function getExtractionCandidates(db: DbClient): Promise<ExtractionCandidate[]> {
  const result = (await db.query(
    `SELECT id, title, description FROM listings WHERE product_id IS NULL`,
    [],
  )) as { rows: ExtractionCandidate[] }
  return result.rows
}

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
// curated-list matching (flagPriceLookupExcluded, below) - this is the
// automatic path, driven by product_enrichment.is_specific_product/confidence
// instead of a human-maintained list. high-confidence "not a real product"
// auto-excludes (reusing price_lookup_excluded, not a new column - same flag
// either writer sets); anything low-confidence goes to
// price_lookup_review_status instead of guessing. NOT p.price_lookup_excluded
// in both guards makes this idempotent to re-run every lap without
// clobbering a curated-list reason that already decided the product.
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
