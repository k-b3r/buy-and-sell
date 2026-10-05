import type { DbClient } from '../../platform/storage'
import { normalizeBaseModel, normalizeVariantTier } from './products'
import type { EnrichmentCandidate, EnrichmentData } from './enrichment'

// The products_base_model_variant_idx identity: one row per normalized
// base_model + variant_tier. Every "does this product already exist" check
// (extraction, merges, mismatch reassignment) goes through here.
export async function findProductIdsByNormalizedName(
  db: DbClient,
  baseModelNormalized: string,
  variantTierNormalized: string | null,
): Promise<number[]> {
  const result = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2`,
    [baseModelNormalized, variantTierNormalized],
  )) as { rows: { id: number }[] }
  return result.rows.map((r) => r.id)
}

export interface ProductIdentity {
  baseModel: string
  variantTier: string | null
  category?: string | null
  subCategory?: string | null
}

// category/subCategory are only ever set at creation, same as
// base_model/variant_tier — dashboard browsing/filtering only, not
// re-classified on subsequent extraction passes that happen to match an
// existing product.
export async function findOrCreateProduct(db: DbClient, product: ProductIdentity): Promise<number> {
  const { baseModel, variantTier, category = null, subCategory = null } = product
  const normalized = normalizeBaseModel(baseModel)
  const normalizedVariant = variantTier === null ? null : normalizeVariantTier(variantTier)

  const existing = await findProductIdsByNormalizedName(db, normalized, normalizedVariant)
  if (existing.length > 0) return existing[0]

  const inserted = (await db.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier, variant_tier_normalized, category_id, sub_category_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM categories WHERE name = $5), (SELECT id FROM categories WHERE name = $6)) RETURNING id`,
    [baseModel, normalized, variantTier, normalizedVariant, category, subCategory],
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

export interface ProductMatchedListing {
  listing_id: string
  title: string
  product_id: number
  base_model: string
  variant_tier: string | null
  variant_tier_normalized: string | null
}

// Every titled listing already assigned a product, with that product's
// names: the input of the model-code mismatch scan.
export async function getProductMatchedListings(db: DbClient): Promise<ProductMatchedListing[]> {
  const result = (await db.query(
    `SELECT l.id AS listing_id, l.title, p.id AS product_id, p.base_model, p.variant_tier, p.variant_tier_normalized
     FROM listings l
     JOIN products p ON p.id = l.product_id
     WHERE l.title IS NOT NULL`,
    [],
  )) as { rows: ProductMatchedListing[] }
  return result.rows
}

export interface ExtractionCandidate {
  id: string
  title: string
  description: string | null
  condition: string | null
  price_amount: number | null
}

// condition/price_amount added (2026-08-31) for the inline discount check
// that now runs right after a listing gets its product_id, in the same
// per-item loop - without them, extract-products.ts would need a second
// per-listing round trip just to re-fetch what it already has here.
export async function getExtractionCandidates(db: DbClient): Promise<ExtractionCandidate[]> {
  const result = (await db.query(
    `SELECT id, title, description, condition, price_amount FROM listings WHERE product_id IS NULL`,
    [],
  )) as { rows: (ExtractionCandidate & { price_amount: string | null })[] }
  return result.rows.map((r) => ({ ...r, price_amount: r.price_amount === null ? null : Number(r.price_amount) }))
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

// Batched single round trip, same reasoning as updateListingProductIds above
// — the Neon round-trip cost dwarfs the LLM cost here. Assignments carry the
// category NAME (from the LLM response / caller), resolved to category_id via
// the join below — categories is a small fixed seeded set, never written to
// here. Used by enrich-products, which assigns a category at first-enrichment
// time.
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
  await db.query(`UPDATE discount_notifications SET product_id = $1 WHERE product_id = $2`, [survivorId, loserId])
  await db.query(
    `UPDATE product_enrichment SET product_id = $1
     WHERE product_id = $2 AND NOT EXISTS (SELECT 1 FROM product_enrichment WHERE product_id = $1)`,
    [survivorId, loserId],
  )
  await db.query(`DELETE FROM product_enrichment WHERE product_id = $1`, [loserId])
  await db.query(`DELETE FROM products WHERE id = $1`, [loserId])
}
