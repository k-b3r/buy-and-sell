import type { DbClient } from '../../platform/storage'
import type { PriceReviewCandidate } from './price-review'
import { descriptionPriceDiverges } from './price-review'
import { matchesNegotiableKeyword } from './negotiable-keywords'
import { getPriceReviewRows, upsertKeywordNegotiable } from './store/listing-price-review'

// Listings worth an LLM price read: the SQL pre-filter's rows (see
// getPriceReviewRows) narrowed to a suspicious price (5x off the product
// median or a placeholder pattern) or one the description contradicts by 5x+
// (descriptionPriceDiverges makes the final divergence call).
export async function getPriceReviewCandidates(db: DbClient): Promise<PriceReviewCandidate[]> {
  const rows = await getPriceReviewRows(db)
  return rows
    .filter((c) => c.priceSuspicious || descriptionPriceDiverges(c.description, c.price_amount))
    .map((c) => ({ id: c.id, title: c.title, description: c.description, price_amount: c.price_amount }))
}

// The deterministic keyword sibling to the LLM-based price review (which
// only ever runs on price-outlier candidates, see getPriceReviewCandidates
// above). Runs on every listing write instead, independent of whether the
// recorded price looks valid, so "nego"/"negotiable" in the text surfaces
// the badge even on a normally priced listing. No-op (no extra round trip)
// when nothing matches, which is the common case. Returns the matched
// keyword, or null when nothing matched.
export async function flagNegotiableFromKeywords(
  db: DbClient,
  listingId: string,
  title: string | null,
  description: string | null,
): Promise<string | null> {
  const matched = matchesNegotiableKeyword(title, description)
  if (!matched) return null
  await upsertKeywordNegotiable(db, listingId, matched)
  return matched
}
