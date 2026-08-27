import type { DbClient } from '../../platform/storage'
import { normalizeBaseModel, normalizeVariantTier } from '../../products'

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
