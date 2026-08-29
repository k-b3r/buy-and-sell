import type { DbClient } from '../../../platform/storage'
import type { ClaudePriceCandidate, PriceRange } from '../claude-price'

// Always an INSERT, never an upsert — each price check is a new point in the
// product's price history, not a replacement of the last one. This is what
// makes a price trend possible: query product_price_history ordered by
// checked_at, don't just read a single "current price" column.
// gemini_grounding/exa_new_retail are retired sources (kept here so any
// historical rows still typecheck) — claude-price-lookup writes 'web_search'
// for both new and used prices now (one row per condition per call).
export type PriceCheckSource = 'gemini_grounding' | 'listing_prices' | 'exa_new_retail' | 'web_search'

// confidence/releaseYear/isDiscontinued were Exa-specific extras — always
// null for the current web_search/listing_prices sources, which have no
// equivalent signal.
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

// Both retail and secondhand prices come from one paid Claude call per
// product now, so every non-excluded product is a candidate regardless of
// listing count. Skips any product with a price row from ANY source — a
// product already priced (by a retired gemini_grounding/exa_new_retail row,
// or a prior web_search row) doesn't need another paid call. Resumable via
// NOT EXISTS, a first-pass fill rather than a re-check-every-run trend —
// each web_search call costs real money, unlike Gemini's old free tier.
// description/sibling_variants (same LEFT JOIN / sibling-lookup shape as the
// enrichment candidate query) disambiguate the search — description may be
// null if this product hasn't been through enrich-products yet.
export async function getWebSearchPriceCandidates(db: DbClient): Promise<ClaudePriceCandidate[]> {
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
  )) as { rows: ClaudePriceCandidate[] }
  return result.rows
}

// Per-product, not per-category — called when the search itself came up
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
