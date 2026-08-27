import type { DbClient } from '../../storage/client'
import type { PriceLookupCandidate, PriceRange } from '../../pricing'

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
// checked_at, don't just read a single "current price" column. Also used
// (cross-worker import) by new-price-lookup and price-from-listings, which
// write different `source` values into the same shared table.
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
