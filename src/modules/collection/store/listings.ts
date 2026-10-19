import type { DbClient } from '../../../platform/storage'
import type { PriorPriceRow } from '../../real-estate'
import type { ListingFields } from '../types'

export async function upsertListingRow(
  db: DbClient,
  f: ListingFields,
  sourcePhotoIds: string[] | null,
  rawJson: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO listings (
       id, title, price_amount, price_currency, description, condition, category_id,
       location_lat, location_lng, location_city, primary_photo_url, stored_photo_urls, source_photo_ids, listed_at, raw_json
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       price_amount = EXCLUDED.price_amount,
       price_currency = EXCLUDED.price_currency,
       description = EXCLUDED.description,
       condition = EXCLUDED.condition,
       category_id = EXCLUDED.category_id,
       location_lat = EXCLUDED.location_lat,
       location_lng = EXCLUDED.location_lng,
       location_city = EXCLUDED.location_city,
       primary_photo_url = EXCLUDED.primary_photo_url,
       stored_photo_urls = EXCLUDED.stored_photo_urls,
       source_photo_ids = EXCLUDED.source_photo_ids,
       listed_at = EXCLUDED.listed_at,
       raw_json = EXCLUDED.raw_json,
       last_seen_at = now(),
       updated_at = now()`,
    [
      f.id,
      f.title,
      f.priceAmount,
      f.priceCurrency,
      f.description,
      f.condition,
      f.categoryId,
      f.locationLat,
      f.locationLng,
      f.locationCity,
      f.primaryPhotoUrl,
      f.storedPhotoUrls ? JSON.stringify(f.storedPhotoUrls) : null,
      sourcePhotoIds ? JSON.stringify(sourcePhotoIds) : null,
      f.listedAt,
      JSON.stringify(rawJson),
    ],
  )
}

// What a recheck refresh does to the photo columns, decided by the caller
// (listings.ts refreshListingFields): none, record the ids as a baseline, or
// replace the stored set after a re-upload.
export type PhotoUpdate =
  | { kind: 'baseline'; sourcePhotoIds: string[] }
  | { kind: 'replace'; primaryPhotoUrl: string | null; storedPhotoUrls: string[]; sourcePhotoIds: string[] }

// Text/price-only refresh of a listing's editable fields, plus the optional
// photo columns. Returns the row as it was before the update (RETURNING from
// a pre-update subselect) so the caller can detect a price change.
export async function updateListingFields(
  db: DbClient,
  f: ListingFields,
  rawJson: Record<string, unknown>,
  photoUpdate: PhotoUpdate | null,
): Promise<PriorPriceRow | undefined> {
  const setClauses = [
    'title = $2',
    'price_amount = $3',
    'price_currency = $4',
    'description = $5',
    'condition = $6',
    'raw_json = $7',
    'last_seen_at = now()',
    'updated_at = now()',
  ]
  const params: unknown[] = [
    f.id,
    f.title,
    f.priceAmount,
    f.priceCurrency,
    f.description,
    f.condition,
    JSON.stringify(rawJson),
  ]
  if (photoUpdate?.kind === 'baseline') {
    params.push(JSON.stringify(photoUpdate.sourcePhotoIds))
    setClauses.push(`source_photo_ids = $${params.length}`)
  } else if (photoUpdate?.kind === 'replace') {
    params.push(
      photoUpdate.primaryPhotoUrl,
      JSON.stringify(photoUpdate.storedPhotoUrls),
      JSON.stringify(photoUpdate.sourcePhotoIds),
    )
    setClauses.push(
      `primary_photo_url = $${params.length - 2}`,
      `stored_photo_urls = $${params.length - 1}`,
      `source_photo_ids = $${params.length}`,
    )
  }

  const setSql = setClauses.join(', ')
  const updated = (await db.query(
    `UPDATE listings SET ${setSql}
     FROM (SELECT price_amount AS old_price_amount, price_currency AS old_price_currency, first_seen_at AS old_first_seen_at
           FROM listings WHERE id = $1) prev
     WHERE listings.id = $1
     RETURNING prev.old_price_amount, prev.old_price_currency, prev.old_first_seen_at`,
    params,
  )) as { rows?: PriorPriceRow[] } | undefined
  return updated?.rows?.[0]
}

// Dedup source for collection runs — replaces the old JSONL-file-based
// loadPersistedIds. Postgres is the single source of truth now; no local
// file can drift out of sync with it (see CONTEXT.md on removing JSONL).
export async function getCollectedListingIds(db: DbClient): Promise<Set<string>> {
  const result = (await db.query('SELECT id FROM listings', [])) as { rows: { id: string }[] }
  return new Set(result.rows.map((r) => r.id))
}

export interface CheckListingsCandidate {
  id: string
  flagged_removed_at: string | null
  source_photo_ids: string[] | null
}

// Never-checked listings (NULLS FIRST) all come before any re-check cycle —
// the first full pass works through the backlog before anything repeats.
// Within that, oldest by the seller's actual FB posting date (listed_at)
// goes first: the longer something's been posted, the likelier it's already
// sold/removed, so checking those first finds genuinely-stale listings fastest.
export async function getCheckListingsCandidates(
  db: DbClient,
  limit: number,
  reRecheckMinDays = 0,
): Promise<CheckListingsCandidate[]> {
  // reRecheckMinDays = 0 (the default) runs the exact original query, so nothing
  // changes for any listing until an operator opts in. When > 0, real estate
  // listings checked within that many days are skipped - property listings
  // change slowly, and every recheck costs live browser time. COALESCE keeps
  // never-checked and non-real-estate rows in (NULL AND ... would drop them).
  const result = (
    reRecheckMinDays > 0
      ? await db.query(
          `SELECT l.id, l.flagged_removed_at, l.source_photo_ids FROM listings l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE l.sold_at IS NULL
           AND NOT COALESCE(c.name = 'Real Estate' AND l.last_checked_at > now() - make_interval(days => $2), false)
         ORDER BY l.last_checked_at ASC NULLS FIRST, l.listed_at ASC NULLS LAST
         LIMIT $1`,
          [limit, reRecheckMinDays],
        )
      : await db.query(
          `SELECT id, flagged_removed_at, source_photo_ids FROM listings
         WHERE sold_at IS NULL
         ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST
         LIMIT $1`,
          [limit],
        )
  ) as { rows: CheckListingsCandidate[] }
  return result.rows
}

// Priority slice for check-listings: unsold listings among `ids` (the ones
// currently ranked on /deals, see pricing's getDealListingIds) that haven't
// been checked within minHours. The recency floor keeps the same top deals
// from being re-checked every lap and starving the rest of the backlog.
// Stalest first, same idiom as getCheckListingsCandidates.
export async function getDealCheckCandidates(
  db: DbClient,
  ids: string[],
  minHoursSinceCheck: number,
): Promise<CheckListingsCandidate[]> {
  if (ids.length === 0) return []
  const result = (await db.query(
    `SELECT id, flagged_removed_at, source_photo_ids FROM listings
     WHERE id = ANY($1)
       AND sold_at IS NULL
       AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(hours => $2))
     ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST`,
    [ids, minHoursSinceCheck],
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
    `SELECT id, flagged_removed_at, source_photo_ids FROM listings
     WHERE product_id = $1
     AND sold_at IS NULL
     ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST`,
    [productId],
  )) as { rows: CheckListingsCandidate[] }
  return result.rows
}

// Single-listing counterpart to getCheckListingsCandidates, for the on-demand
// refresh path (see server/routes/refresh.ts) - same shape (id + flagged_removed_at)
// so checkOneListing's two-phase soft-wall logic works identically whether
// the candidate came from the batch query or a one-off request. Does NOT
// filter on sold_at IS NULL - a sold listing can still be manually refreshed
// (e.g. to double-check it wasn't a false positive).
export async function getListingCheckCandidate(db: DbClient, id: string): Promise<CheckListingsCandidate | null> {
  const result = (await db.query(`SELECT id, flagged_removed_at, source_photo_ids FROM listings WHERE id = $1`, [
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

export interface BackfillCandidate {
  id: string
  raw_json: Record<string, unknown>
}

export async function getBackfillCandidates(db: DbClient): Promise<BackfillCandidate[]> {
  const result = (await db.query(`SELECT id, raw_json FROM listings WHERE stored_photo_urls IS NULL`, [])) as {
    rows: BackfillCandidate[]
  }
  return result.rows
}

// Reversible: a listing later confirmed still live (via a validation pass)
// can just be re-run through backfill, which overwrites this with real URLs.
export async function markListingPhotosUnavailable(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET stored_photo_urls = '[]'::jsonb WHERE id = $1`, [id])
}
