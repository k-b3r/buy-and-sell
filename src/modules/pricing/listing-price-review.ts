import type { DbClient } from '../../platform/storage'
import type { PriceReviewCandidate, PriceReviewData } from './price-review'
import { descriptionPriceDiverges } from './price-review'
import { matchesNegotiableKeyword } from './negotiable-keywords'
import { medianCtes, notPlaceholderPriceSql } from './clean-median'

export interface NegotiableKeywordCandidate {
  id: string
  title: string
  description: string | null
}

// Backfill's candidate set: every listing not already flagged negotiable -
// includes ones with no listing_price_review row at all, and ones an LLM
// review already looked at but read as false (a keyword hit here can still
// upgrade that, see upsertKeywordNegotiable below; it never downgrades).
// Deliberately not limited to price-outlier listings the way
// getPriceReviewCandidates' candidate query is - the whole point is to
// catch "nego" on a normally-priced listing too.
export async function getNegotiableKeywordCandidates(db: DbClient): Promise<NegotiableKeywordCandidate[]> {
  const result = (await db.query(
    `SELECT l.id, l.title, l.description
     FROM listings l
     WHERE NOT EXISTS (
       SELECT 1 FROM listing_price_review pr WHERE pr.listing_id = l.id AND pr.is_negotiable = true
     )`,
    [],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: r.description as string | null,
  }))
}

// Loose SQL pre-filter for "the description names a price": any currency/
// keyword-prefixed number, or a k-abbreviated one. Deliberately over-matches
// - descriptionPriceDiverges (JS) does the precise extraction and the 5x
// divergence check on the rows this lets through.
const DESCRIPTION_MENTIONS_PRICE_SQL = `(
  l.description ~* '(₱|php|price|asking|presyo|selling|srp)[^0-9₱]{0,6}[0-9]'
  OR l.description ~* '[0-9][ ]?k\\y'
)`

// Tighter than the clean median's MAGNITUDE_OUTLIER_RATIO on purpose (see
// getPriceReviewCandidates): this only nominates listings for an LLM read.
const REVIEW_OUTLIER_RATIO = 5

// Cheap SQL pre-filter, no LLM: flags a listing when its price is a magnitude
// outlier (>5x off its product's own median in either direction), a
// placeholder digit-pattern regardless of magnitude, OR names a price in its
// description that the recorded price is 5x+ off (getPriceReviewCandidates'
// JS post-filter makes the final divergence call - the SQL branch here just
// avoids fetching every listing). The 5x median band (was 10x) is tight
// enough to catch a single dropped digit; the description-divergence branch
// backstops it when the product median itself is unreliable.
// Products with only one listing can never flag themselves on magnitude
// alone (their price equals their own median) - the other two branches still
// catch them. The median itself excludes placeholder prices from its own
// input pool, same reasoning as the dashboard's SIBLING_MEDIAN_SQL/
// DISCOUNT_SUMMARY_LATERAL - a placeholder shouldn't skew the median used to
// judge everything else. The LEFT JOIN + "description changed since review"
// gate is the resumability mechanism: a listing gets re-reviewed once its
// seller edits the description (a price clarification is the case that
// matters), not on every re-scrape - refreshListingFields bumps updated_at
// unconditionally, so a stored description snapshot is the only reliable
// change signal.
export async function getPriceReviewCandidates(db: DbClient): Promise<PriceReviewCandidate[]> {
  const result = (await db.query(
    `WITH ${medianCtes({
      name: 'product_medians',
      pool: 'SELECT product_id, price_amount FROM listings WHERE product_id IS NOT NULL',
      clean: false,
    })},
     flagged AS (
       SELECT l.id, l.title, l.description, l.price_amount,
         (l.price_amount < m.raw_median_price / ${REVIEW_OUTLIER_RATIO} OR l.price_amount > m.raw_median_price * ${REVIEW_OUTLIER_RATIO}) AS price_outlier,
         NOT ${notPlaceholderPriceSql('l.price_amount')} AS placeholder_price,
         ${DESCRIPTION_MENTIONS_PRICE_SQL} AS description_mentions_price
       FROM listings l
       JOIN product_medians m ON m.product_id = l.product_id
       LEFT JOIN listing_price_review r ON r.listing_id = l.id
       WHERE l.price_amount IS NOT NULL
         AND (r.listing_id IS NULL OR l.description IS DISTINCT FROM r.reviewed_description)
     )
     SELECT id, title, description, price_amount, price_outlier, placeholder_price
     FROM flagged
     WHERE price_outlier OR placeholder_price OR description_mentions_price`,
    [],
  )) as { rows: Record<string, unknown>[] }
  return result.rows
    .map((r) => ({
      id: r.id as string,
      title: r.title as string,
      description: (r.description as string | null) ?? null,
      price_amount: Number(r.price_amount),
      priceSuspicious: r.price_outlier === true || r.placeholder_price === true,
    }))
    .filter((c) => c.priceSuspicious || descriptionPriceDiverges(c.description, c.price_amount))
    .map((c) => ({ id: c.id, title: c.title, description: c.description, price_amount: c.price_amount }))
}

// listings.price_amount is never written here - this table is purely additive,
// same as product_enrichment is for products (see db/schema.sql).
// reviewedDescription is the description text this review was based on -
// stored so getPriceReviewCandidates can tell when a later seller edit
// warrants a fresh review.
export async function upsertListingPriceReview(
  db: DbClient,
  listingId: string,
  data: PriceReviewData,
  model: string,
  reviewedDescription: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO listing_price_review (listing_id, is_negotiable, price_low, price_high, reasoning, model, reviewed_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (listing_id) DO UPDATE SET
       is_negotiable = EXCLUDED.is_negotiable,
       price_low = EXCLUDED.price_low,
       price_high = EXCLUDED.price_high,
       reasoning = EXCLUDED.reasoning,
       model = EXCLUDED.model,
       reviewed_description = EXCLUDED.reviewed_description,
       checked_at = now()`,
    [listingId, data.isNegotiable, data.priceLow, data.priceHigh, data.reasoning, model, reviewedDescription],
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

// The deterministic keyword sibling to the LLM-based price review (which
// only ever runs on price-outlier candidates, see getPriceReviewCandidates
// above). Runs on every listing write instead, independent of whether the
// recorded price looks valid, so "nego"/"negotiable" in the text surfaces
// the badge even on a normally priced listing. No-op (no extra round trip)
// when nothing matches, which is the common case.
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
