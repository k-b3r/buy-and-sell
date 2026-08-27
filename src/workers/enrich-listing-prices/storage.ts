import type { DbClient } from '../../storage'
import type { PriceReviewCandidate } from '../../price-review'
import { matchesNegotiableKeyword } from '../../negotiable-keywords'

// Same digit-pattern heuristic as the dashboard's isPlaceholderPrice/
// notPlaceholderPriceSql (dashboard/src/lib/queries.ts) - kept as a separate
// copy since src/ and dashboard/ are deliberately separate packages (own
// pnpm-workspace.yaml, see README), not shared code. Catches "for attention
// only" prices like 123, 999, or 12,567 (an embedded ascending run) that
// aren't a real ask at all - independent of the magnitude-outlier check
// below, since a placeholder can sit well within 10x of a real median.
const PLACEHOLDER_PRICE_SQL = (column: string): string => `(
  length(trunc(${column})::text) >= 3
  AND (
    trunc(${column})::text ~ '^(\\d+)\\1+$'
    OR trunc(${column})::text ~ '012|123|234|345|456|567|678|789'
  )
)`

// Cheap SQL-only pre-filter, no LLM: flags listings whose price is either a
// magnitude outlier (>10x off their product's own median in either
// direction) or a placeholder digit-pattern, regardless of magnitude.
// Products with only one listing can never flag themselves on magnitude
// alone (their price equals their own median) - a placeholder pattern still
// catches them either way. The median itself excludes placeholder prices
// from its own input pool, same reasoning as the dashboard's SIBLING_MEDIAN_SQL/
// DISCOUNT_SUMMARY_LATERAL - a placeholder shouldn't be allowed to skew the
// median used to judge everything else. NOT EXISTS on listing_price_review is
// the resumability mechanism, same pattern as enrich-products/storage.ts.
export async function getPriceReviewCandidates(db: DbClient): Promise<PriceReviewCandidate[]> {
  const result = (await db.query(
    `WITH product_medians AS (
       SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price
       FROM listings
       WHERE product_id IS NOT NULL AND price_amount IS NOT NULL AND price_amount > 0
         AND NOT ${PLACEHOLDER_PRICE_SQL('price_amount')}
       GROUP BY product_id
     )
     SELECT l.id, l.title, l.description, l.price_amount
     FROM listings l
     JOIN product_medians m ON m.product_id = l.product_id
     WHERE l.price_amount IS NOT NULL
       AND (
         l.price_amount < m.median_price / 10 OR l.price_amount > m.median_price * 10
         OR ${PLACEHOLDER_PRICE_SQL('l.price_amount')}
       )
       AND NOT EXISTS (SELECT 1 FROM listing_price_review r WHERE r.listing_id = l.id)`,
    [],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: r.description as string | null,
    price_amount: Number(r.price_amount),
  }))
}

export interface PriceReviewData {
  isNegotiable: boolean
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}

// listings.price_amount is never written here - this table is purely additive,
// same as product_enrichment is for products (see db/schema.sql).
export async function upsertListingPriceReview(
  db: DbClient,
  listingId: string,
  data: PriceReviewData,
  model: string,
): Promise<void> {
  await db.query(
    `INSERT INTO listing_price_review (listing_id, is_negotiable, price_low, price_high, reasoning, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (listing_id) DO UPDATE SET
       is_negotiable = EXCLUDED.is_negotiable,
       price_low = EXCLUDED.price_low,
       price_high = EXCLUDED.price_high,
       reasoning = EXCLUDED.reasoning,
       model = EXCLUDED.model,
       checked_at = now()`,
    [listingId, data.isNegotiable, data.priceLow, data.priceHigh, data.reasoning, model],
  )
}

// Deliberately narrower than upsertListingPriceReview: only ever flips
// is_negotiable to true, never touches price_low/price_high/reasoning/model
// on an existing row. A keyword hit is a weaker, purely textual signal next
// to the LLM price-review's actual read of the listing (which also produces
// a real price estimate) - overwriting that with nulls here would be a
// regression, not an improvement. Safe to call unconditionally on every
// match; it's a no-op once a listing is already flagged negotiable.
export async function upsertKeywordNegotiable(db: DbClient, listingId: string, matchedKeyword: string): Promise<void> {
  await db.query(
    `INSERT INTO listing_price_review (listing_id, is_negotiable, price_low, price_high, reasoning, model)
     VALUES ($1, true, NULL, NULL, $2, 'keyword-scan')
     ON CONFLICT (listing_id) DO UPDATE SET
       is_negotiable = true,
       checked_at = now()`,
    [listingId, `keyword match: "${matchedKeyword}"`],
  )
}

// Shared by cli/storage.ts's upsertListing and check-listings/storage.ts's
// refreshListingFields (both cross-worker imports of this file) - the
// deterministic keyword sibling to the LLM-based price review (which only
// ever runs on price-outlier candidates, see getPriceReviewCandidates above).
// Runs on every write instead, independent of whether the recorded price
// looks valid, so "nego"/"negotiable" in the text surfaces the badge even on
// a normally priced listing. No-op (no extra round trip) when nothing matches,
// which is the common case.
export async function flagNegotiableFromKeywords(
  db: DbClient,
  listingId: string,
  title: string | null,
  description: string | null,
): Promise<void> {
  const matched = matchesNegotiableKeyword(title, description)
  if (!matched) return
  await upsertKeywordNegotiable(db, listingId, matched)
}
