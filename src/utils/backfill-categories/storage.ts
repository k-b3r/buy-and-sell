import type { DbClient } from '../../storage'
import type { CategoryBackfillCandidate } from '../../products'

// category_id IS NULL is both the filter and the resumability marker — no
// separate results table needed (same pattern as enrich-products' candidate
// query). Only pre-existing products lack a category; extract-products
// assigns it at creation time for everything new, so this backlog only shrinks.
export async function getCategoryBackfillCandidates(db: DbClient): Promise<CategoryBackfillCandidate[]> {
  const result = (await db.query(
    `SELECT id, base_model, variant_tier FROM products WHERE category_id IS NULL ORDER BY id`,
    [],
  )) as { rows: CategoryBackfillCandidate[] }
  return result.rows
}

// Batched single round trip, same reasoning as extract-products/storage.ts's
// updateListingProductIds — the Neon round-trip cost dwarfs the LLM cost
// here. Assignments carry the category NAME (from the LLM response / caller),
// resolved to category_id via the join below — categories is a small fixed
// seeded set, never written to here. Also used (cross-worker import) by
// enrich-products, which assigns a category at first-enrichment time too.
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
