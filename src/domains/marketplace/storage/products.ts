import type { DbClient } from '../../../platform/storage'
import { normalizeBaseModel, normalizeVariantTier } from '../products'
import type { EnrichmentCandidate, EnrichmentData } from '../enrichment'
import type { CategoryBackfillCandidate } from '../products'

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

// category_id IS NULL is both the filter and the resumability marker — no
// separate results table needed (same pattern as the enrichment candidate
// query above). Only pre-existing products lack a category; extract-products
// assigns it at creation time for everything new, so this backlog only shrinks.
export async function getCategoryBackfillCandidates(db: DbClient): Promise<CategoryBackfillCandidate[]> {
  const result = (await db.query(
    `SELECT id, base_model, variant_tier FROM products WHERE category_id IS NULL ORDER BY id`,
    [],
  )) as { rows: CategoryBackfillCandidate[] }
  return result.rows
}

// Batched single round trip, same reasoning as updateListingProductIds above
// — the Neon round-trip cost dwarfs the LLM cost here. Assignments carry the
// category NAME (from the LLM response / caller), resolved to category_id via
// the join below — categories is a small fixed seeded set, never written to
// here. Also used by enrich-products, which assigns a category at
// first-enrichment time too.
export async function updateProductCategories(
  db: DbClient,
  assignments: { id: number; category: string }[],
): Promise<void> {
  if (assignments.length === 0) return

  const valuesSql = assignments.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`).join(', ')
  const params = assignments.flatMap((a) => [a.id, a.category])

  await db.query(
    `UPDATE products SET category_id = c.id
     FROM (VALUES ${valuesSql}) AS data(id, category)
     JOIN categories c ON c.name = data.category
     WHERE products.id = data.id`,
    params,
  )
}

// Merges loserId into survivorId — same real product, split into two rows by
// inconsistent extraction text (e.g. "PS5" vs "PlayStation 5"). Reassigns real
// scraped/paid data (listings, product_price_history) unconditionally. For
// product_enrichment (product_id is its PRIMARY KEY, so both rows can't keep
// one each): migrates the loser's row over only if the survivor doesn't
// already have one, otherwise just drops the loser's — it's free/regenerable
// via Groq, not worth reconciling two descriptions. Caller is responsible for
// deciding survivor/loser and must not call this if it would collide with a
// still-existing third row.
export async function mergeDuplicateProduct(db: DbClient, survivorId: number, loserId: number): Promise<void> {
  await db.query(`UPDATE listings SET product_id = $1 WHERE product_id = $2`, [survivorId, loserId])
  await db.query(`UPDATE product_price_history SET product_id = $1 WHERE product_id = $2`, [survivorId, loserId])
  await db.query(
    `UPDATE product_enrichment SET product_id = $1
     WHERE product_id = $2 AND NOT EXISTS (SELECT 1 FROM product_enrichment WHERE product_id = $1)`,
    [survivorId, loserId],
  )
  await db.query(`DELETE FROM product_enrichment WHERE product_id = $1`, [loserId])
  await db.query(`DELETE FROM products WHERE id = $1`, [loserId])
}

// Manually curated categories (real estate, bare placeholders, parts with no
// single fixed price, services) — see db/schema.sql. Idempotent: matches on
// base_model text, safe to re-run as more junk categories turn up over time.
export async function flagPriceLookupExcluded(db: DbClient, baseModels: string[], reason: string): Promise<void> {
  await db.query(`UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE base_model = ANY($2)`, [
    reason,
    baseModels,
  ])
}
