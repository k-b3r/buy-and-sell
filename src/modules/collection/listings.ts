import type { DbClient } from '../../platform/storage'
import type { Logger } from '../../platform/logger'
import type { PriorPriceRow } from '../real-estate'
import { recordRealEstatePriceChange } from '../real-estate'
import type { ListingPhotos } from './photos'
// Negotiable-keyword flagging is pricing's rule, run on every listing write.
import { flagNegotiableFromKeywords } from '../pricing'

function extractField(listing: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (listing[key] !== undefined && listing[key] !== null) return listing[key]
  }
  return null
}

interface ParsedListingFields {
  id: string
  title: string | null
  priceAmount: number | null
  priceCurrency: string | null
  description: string | null
  condition: string | null
  categoryId: string | null
  locationLat: number | null
  locationLng: number | null
  locationCity: string | null
  primaryPhotoUrl: string | null
  storedPhotoUrls: string[] | null
  listedAt: Date | null
}

// Shared by upsertListing (full insert/refresh, including photos) and
// refreshListingFields (text/price-only refresh) so the two can't drift on
// how a raw Facebook listing object gets parsed.
function parseListingFields(listing: Record<string, unknown>): ParsedListingFields {
  const id = String(listing.id)
  const title = extractField(listing, 'marketplace_listing_title', 'custom_title') as string | null

  const priceObj = listing.listing_price as { amount?: string; currency?: string } | undefined
  const priceAmount = priceObj?.amount !== undefined ? Number(priceObj.amount) : null
  const priceCurrency = priceObj?.currency ?? null

  const description = (listing.redacted_description as { text?: string } | undefined)?.text ?? null
  // Facebook nests condition inside attribute_data (an array of {label, value,
  // attribute_name} entries covering Condition, Brand, etc.), not a top-level
  // "condition" field — confirmed live, 97% of real listings have it here.
  const attributeData = listing.attribute_data as { label?: string; attribute_name?: string }[] | undefined
  const condition = attributeData?.find((a) => a.attribute_name === 'Condition')?.label ?? null
  const categoryId = (listing.marketplace_listing_category_id as string | undefined) ?? null

  const location = listing.location as
    { latitude?: number; longitude?: number; reverse_geocode?: { city?: string } } | undefined
  const locationLat = location?.latitude ?? null
  const locationLng = location?.longitude ?? null
  const locationCity = location?.reverse_geocode?.city ?? null

  const primaryPhotoUrl =
    (listing.primary_listing_photo as { image?: { uri?: string } } | undefined)?.image?.uri ?? null
  const storedPhotoUrls = (listing.stored_photo_urls as string[] | undefined) ?? null

  const creationTime = listing.creation_time as number | undefined
  const listedAt = creationTime ? new Date(creationTime * 1000) : null

  return {
    id,
    title,
    priceAmount,
    priceCurrency,
    description,
    condition,
    categoryId,
    locationLat,
    locationLng,
    locationCity,
    primaryPhotoUrl,
    storedPhotoUrls,
    listedAt,
  }
}

// Facebook's own per-photo id, stable across the CDN url's ever-rotating
// signed tokens (unlike the url itself) - this is what lets a later recheck
// tell "seller swapped photos" apart from "same photo, url just re-signed".
// Returns null when listing_photos isn't present/an array at all (a plain
// title/price re-scrape can legitimately lack it) - distinct from an empty
// array, which means Facebook explicitly reported zero photos right now.
function extractPhotoIds(listing: Record<string, unknown>): string[] | null {
  const photos = listing.listing_photos
  if (!Array.isArray(photos)) return null
  return photos.map((p) => (p as { id?: unknown } | undefined)?.id).filter((id): id is string => typeof id === 'string')
}

function photoIdsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

export async function upsertListing(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)
  const photoIds = extractPhotoIds(listing)

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
      photoIds ? JSON.stringify(photoIds) : null,
      f.listedAt,
      JSON.stringify(listing),
    ],
  )
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
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
// refresh path (see refresh-server.ts) - same shape (id + flagged_removed_at)
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

// check-listings calls this when a re-checked listing is confirmed still
// live (not sold/removed) - a re-scraped detail page reflects whatever the
// seller has since edited (price cut, updated description, corrected
// condition), so without this the stored row would only ever show its
// first-seen snapshot forever. Deliberately excludes category_id/location -
// scoped to fields a seller can actually edit post-listing.
//
// Photos are the one field that DOES get touched here, but conditionally:
// storedPhotoIds is the listing's last-known source_photo_ids (from the
// CheckListingsCandidate row) - the caller's job, not this function's, to
// avoid a redundant read. Facebook's own per-photo id (unlike the CDN url,
// which re-signs on every fetch) is what lets "seller swapped photos" be
// told apart from "same photo, url just rotated":
//   - no stored baseline yet (null) -> capture the current ids, no re-fetch.
//     Ships against ~11k listings with zero history - forcing a real
//     re-fetch on all of them the moment this lands would spike CPU (sharp
//     compression) and R2 writes across the whole backlog at once.
//   - baseline present, ids match -> untouched, same as before this existed.
//   - baseline present, ids differ -> a real change: re-download + re-upload
//     via the same ListingPhotos.save used at initial collection (not
//     duplicated), overwriting primary_photo_url/stored_photo_urls/
//     source_photo_ids together. A total re-fetch failure (all photos
//     unreachable) leaves the existing good copies untouched rather than
//     wiping them - it'll just look "changed" again next check and retry.
export async function refreshListingFields(
  { db, photos, logger }: { db: DbClient; photos: ListingPhotos; logger: Logger },
  storedPhotoIds: string[] | null,
  listing: Record<string, unknown>,
): Promise<void> {
  const f = parseListingFields(listing)
  const currentPhotoIds = extractPhotoIds(listing)

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
    JSON.stringify(listing),
  ]

  if (currentPhotoIds !== null) {
    if (storedPhotoIds === null) {
      params.push(JSON.stringify(currentPhotoIds))
      setClauses.push(`source_photo_ids = $${params.length}`)
    } else if (!photoIdsEqual(currentPhotoIds, storedPhotoIds)) {
      logger.info(`listing ${f.id} photos changed since last check, re-fetching`)
      await photos.deleteAll(f.id)
      const newUrls = await photos.save(f.id, listing.listing_photos)
      if (newUrls.length > 0) {
        params.push(f.primaryPhotoUrl, JSON.stringify(newUrls), JSON.stringify(currentPhotoIds))
        setClauses.push(
          `primary_photo_url = $${params.length - 2}`,
          `stored_photo_urls = $${params.length - 1}`,
          `source_photo_ids = $${params.length}`,
        )
      } else {
        logger.warn(`listing ${f.id} photo re-fetch returned nothing, keeping existing photos`)
      }
    }
  }

  const updated = (await db.query(
    `UPDATE listings SET ${setClauses.join(', ')}
     FROM (SELECT price_amount AS old_price_amount, price_currency AS old_price_currency, first_seen_at AS old_first_seen_at
           FROM listings WHERE id = $1) prev
     WHERE listings.id = $1
     RETURNING prev.old_price_amount, prev.old_price_currency, prev.old_first_seen_at`,
    params,
  )) as { rows?: PriorPriceRow[] } | undefined
  await recordRealEstatePriceChange(db, logger, f.id, updated?.rows?.[0], f.priceAmount, f.priceCurrency)
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
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
