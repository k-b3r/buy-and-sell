import type { DbClient } from '../../platform/storage'
import type { NewPriceCandidate } from '../../domains/marketplace'

// New-retail price is a per-model fact, not tied to condition or how many
// listings we've collected of it — unlike price-lookup's candidate query
// (which only bothers with products that have >=2 listings), every product
// is a candidate. Skips any product with a price row from ANY source (not
// just exa_new_retail) — a product already priced by gemini_grounding or
// listing_prices doesn't need an Exa call too (each Exa search costs real
// money, unlike Groq/Gemini's free tiers). Resumable via NOT EXISTS, first-
// pass fill, not a re-check-every-run trend. description/sibling_variants
// (same LEFT JOIN / sibling-lookup shape as enrich-products' candidate query)
// give Exa's search disambiguating context — description may be null if this
// product hasn't been through enrich-products yet.
export async function getNewPriceCandidates(db: DbClient): Promise<NewPriceCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, e.description,
       COALESCE(
         (SELECT array_agg(DISTINCT COALESCE(p2.variant_tier, '(base, no variant)'))
          FROM products p2
          WHERE p2.base_model_normalized = p.base_model_normalized AND p2.id != p.id),
         ARRAY[]::text[]
       ) as sibling_variants
     FROM products p
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     WHERE NOT p.price_lookup_excluded
       AND p.price_lookup_review_status IS DISTINCT FROM 'needs_review'
       AND NOT EXISTS (
         SELECT 1 FROM product_price_history h WHERE h.product_id = p.id
       )
     ORDER BY p.id`,
    [],
  )) as { rows: NewPriceCandidate[] }
  return result.rows
}

// Per-product, not per-category — called when Exa itself searched and came up
// empty for this specific product, not for a transient request failure. One
// real "no result" is a strong enough signal not to keep paying for the same
// search again on every future run.
export async function flagProductPriceLookupExcluded(db: DbClient, productId: number, reason: string): Promise<void> {
  await db.query(`UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE id = $2`, [reason, productId])
}
