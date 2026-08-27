import type { DbClient } from '../../platform/storage'
import { parseListingFields } from '../collect/storage'
import { flagNegotiableFromKeywords } from '../enrich-listing-prices/storage'

export interface CheckListingsCandidate {
  id: string
  flagged_removed_at: string | null
}

// Never-checked listings (NULLS FIRST) all come before any re-check cycle —
// the first full pass works through the backlog before anything repeats.
// Within that, oldest by the seller's actual FB posting date (listed_at)
// goes first: the longer something's been posted, the likelier it's already
// sold/removed, so checking those first finds genuinely-stale listings fastest.
export async function getCheckListingsCandidates(db: DbClient, limit: number): Promise<CheckListingsCandidate[]> {
  const result = (await db.query(
    `SELECT id, flagged_removed_at FROM listings
     WHERE sold_at IS NULL
     ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST
     LIMIT $1`,
    [limit],
  )) as { rows: CheckListingsCandidate[] }
  return result.rows
}

// Scoped counterpart to getCheckListingsCandidates, for the dashboard's
// per-product bulk refresh (see server/routes/refreshProduct.ts) - same
// sold-exclusion and staleness ordering, just narrowed to one product's
// listings instead of the whole backlog. No LIMIT - a bulk job checks every
// eligible listing under the product, not a capped batch.
export async function getListingCheckCandidatesForProduct(
  db: DbClient,
  productId: number,
): Promise<CheckListingsCandidate[]> {
  const result = (await db.query(
    `SELECT id, flagged_removed_at FROM listings
     WHERE product_id = $1
     AND sold_at IS NULL
     ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST`,
    [productId],
  )) as { rows: CheckListingsCandidate[] }
  return result.rows
}

// Single-listing counterpart to getCheckListingsCandidates, for the on-demand
// refresh path (see refresh-server.ts) - same shape (id + flagged_removed_at)
// so checkOneListing's two-phase soft-wall logic works identically whether
// the candidate came from the batch query or a one-off request. Does NOT
// filter on sold_at IS NULL - a sold listing can still be manually refreshed
// (e.g. to double-check it wasn't a false positive).
export async function getListingCheckCandidate(db: DbClient, id: string): Promise<CheckListingsCandidate | null> {
  const result = (await db.query(`SELECT id, flagged_removed_at FROM listings WHERE id = $1`, [
    id,
  ])) as { rows: CheckListingsCandidate[] }
  return result.rows[0] ?? null
}

// Real content found — clears any prior removal flag too, treating a listing
// that recovers after being flagged as a false positive, not something to
// silently leave flagged. Also clears sold_at, for the same reason (a listing
// that's actually still live and unsold shouldn't stay marked sold).
export async function markListingAlive(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE listings SET last_checked_at = now(), flagged_removed_at = NULL, sold_at = NULL WHERE id = $1`,
    [id],
  )
}

// Sold is a terminal, definite signal from Facebook itself (raw_json.is_sold) —
// no soft-wall-style two-phase confirmation needed, unlike flagListingRemoved.
// getCheckListingsCandidates excludes sold_at IS NOT NULL rows, so a sold
// listing is never re-checked again.
export async function markListingSold(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET sold_at = now(), last_checked_at = now() WHERE id = $1`, [id])
}

// First soft-wall hit — not deleted yet. See db/schema.sql for why one hit
// alone isn't trusted (indistinguishable from a transient session wall).
export async function flagListingRemoved(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET flagged_removed_at = now(), last_checked_at = now() WHERE id = $1`, [id])
}

// Only called when a listing was already flagged from a prior, separate run
// and is still soft-walled now — confirmed removed. Products are never
// cascade-deleted here, even if this was their last remaining listing.
export async function deleteListing(db: DbClient, id: string): Promise<void> {
  await db.query(`DELETE FROM listings WHERE id = $1`, [id])
}

// check-listings.ts calls this when a re-checked listing is confirmed still
// live (not sold/removed) - a re-scraped detail page reflects whatever the
// seller has since edited (price cut, updated description, corrected
// condition), so without this the stored row would only ever show its
// first-seen snapshot forever. Deliberately excludes photo fields
// (primary_photo_url/stored_photo_urls) and category_id/location - a plain
// detail-page scrape has no knowledge of the R2-uploaded copy backfill/index.ts
// already produced, and overwriting with the raw FB CDN link (or null)
// would silently undo that work.
export async function refreshListingFields(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)

  await db.query(
    `UPDATE listings SET
       title = $2,
       price_amount = $3,
       price_currency = $4,
       description = $5,
       condition = $6,
       raw_json = $7,
       last_seen_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [f.id, f.title, f.priceAmount, f.priceCurrency, f.description, f.condition, JSON.stringify(listing)],
  )
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
}
