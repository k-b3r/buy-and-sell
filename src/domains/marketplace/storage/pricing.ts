import type { DbClient } from '../../../platform/storage'
import type { PriceLookupCandidate, PriceRange } from '../pricing'
import type { NewPriceCandidate } from '../new-price'

// A market range is more meaningful with more than one data point, and it
// keeps the per-run request volume to a small, deliberately-scoped subset of
// the full product list rather than every single-listing product too.
export async function getPriceLookupCandidates(db: DbClient): Promise<PriceLookupCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier
     FROM products p
     JOIN listings l ON l.product_id = p.id
     WHERE NOT p.price_lookup_excluded
       AND p.price_lookup_review_status IS DISTINCT FROM 'needs_review'
     GROUP BY p.id, p.base_model, p.variant_tier
     HAVING count(l.id) >= 2
     ORDER BY count(l.id) DESC`,
    [],
  )) as { rows: PriceLookupCandidate[] }
  return result.rows
}

// Always an INSERT, never an upsert — each price check is a new point in the
// product's price history, not a replacement of the last one. This is what
// makes a price trend possible: query product_price_history ordered by
// checked_at, don't just read a single "current price" column. Also used by
// retail-price-lookup and price-from-listings, which write different
// `source` values into the same shared table.
export type PriceCheckSource = 'gemini_grounding' | 'listing_prices' | 'exa_new_retail'

// confidence is Exa-specific (its grounding data reports "high"/"low" per
// field, see new-price.ts's extractNewPriceConfidence) — null for
// gemini_grounding/listing_prices sources, which have no equivalent signal.
// releaseYear/isDiscontinued are likewise Exa-only (extractNewPriceMetadata)
// — free extra fields from the same already-paid-for search.
export async function insertPriceCheck(
  db: DbClient,
  productId: number,
  price: PriceRange,
  rawResponse: string,
  source: PriceCheckSource,
  condition: string | null = null,
  confidence: string | null = null,
  releaseYear: number | null = null,
  isDiscontinued: boolean | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO product_price_history (product_id, price_low, price_high, price_currency, raw_response, source, condition, confidence, release_year, is_discontinued)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [productId, price.low, price.high, price.currency, rawResponse, source, condition, confidence, releaseYear, isDiscontinued],
  )
}

// New-retail price is a per-model fact, not tied to condition or how many
// listings we've collected of it — unlike getPriceLookupCandidates (which
// only bothers with products that have >=2 listings), every product is a
// candidate. Skips any product with a price row from ANY source (not just
// exa_new_retail) — a product already priced by gemini_grounding or
// listing_prices doesn't need an Exa call too (each Exa search costs real
// money, unlike Groq/Gemini's free tiers). Resumable via NOT EXISTS, first-
// pass fill, not a re-check-every-run trend. description/sibling_variants
// (same LEFT JOIN / sibling-lookup shape as the enrichment candidate query)
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

export interface ListingPricesForProductCondition {
  id: number
  base_model: string
  variant_tier: string | null
  condition: string
  prices: number[]
}

// One group per (product, condition) pair, not per product — a blended range
// across conditions hides real price-relevant variance (a "Used - Fair" and
// a "New" of the same product don't belong in one range). Listings with no
// stated condition can't be assigned a tier, so they're excluded here (they
// were previously folded into a blended "probably used" range; now that a
// per-condition breakdown exists, an unlabeled listing has nowhere honest to go).
export async function getListingPricesByProduct(db: DbClient): Promise<ListingPricesForProductCondition[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, l.condition, array_agg(l.price_amount) AS prices
     FROM products p
     JOIN listings l ON l.product_id = p.id
     WHERE l.price_amount IS NOT NULL AND l.condition IS NOT NULL
     GROUP BY p.id, p.base_model, p.variant_tier, l.condition
     HAVING count(l.id) >= 2
     ORDER BY count(l.id) DESC`,
    [],
  )) as { rows: { id: number; base_model: string; variant_tier: string | null; condition: string; prices: string[] }[] }
  return result.rows.map((r) => ({
    id: r.id,
    base_model: r.base_model,
    variant_tier: r.variant_tier,
    condition: r.condition,
    prices: r.prices.map(Number),
  }))
}
