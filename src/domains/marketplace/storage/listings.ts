import type { DbClient } from '../../../platform/storage'
import type { PriceReviewCandidate, PriceReviewData } from '../price-review'
import { descriptionPriceDiverges } from '../price-review'
import { matchesNegotiableKeyword } from '../negotiable-keywords'
import type { PriceRange } from '../price-lookup'
import type { ImageStore, FetchBytes, CompressImage } from '../../../platform/images'
import {
  storeListingPhotos,
  deleteListingPhotos,
  defaultFetchBytes,
  defaultCompressImage,
} from '../../../platform/images'
import type { Logger } from '../../../platform/logger'

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

interface PriorPriceRow {
  old_price_amount: string | number | null
  old_price_currency: string | null
  old_first_seen_at: string | Date
}

// Real estate only: every other category returns early at the probe, so the
// non-real-estate path pays nothing unless its price actually changed (and
// then one indexed SELECT). Best-effort by design - a failure here must never
// fail the listing refresh, so it is logged and swallowed.
async function recordRealEstatePriceChange(
  db: DbClient,
  logger: Logger,
  listingId: string,
  prior: PriorPriceRow | undefined,
  newPrice: number | null,
  newCurrency: string | null,
): Promise<void> {
  if (!prior) return
  const oldPrice =
    prior.old_price_amount === null || prior.old_price_amount === undefined ? null : Number(prior.old_price_amount)
  if (oldPrice === newPrice) return
  try {
    const probe = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM listing_price_history h WHERE h.listing_id = l.id) AS has_history
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE l.id = $1 AND c.name = 'Real Estate'`,
      [listingId],
    )) as { rows?: { has_history: boolean }[] } | undefined
    const row = probe?.rows?.[0]
    if (!row) return
    if (!row.has_history) {
      await db.query(
        `INSERT INTO listing_price_history (listing_id, price_amount, price_currency, recorded_at) VALUES ($1, $2, $3, $4)`,
        [listingId, oldPrice, prior.old_price_currency, prior.old_first_seen_at],
      )
    }
    await db.query(`INSERT INTO listing_price_history (listing_id, price_amount, price_currency) VALUES ($1, $2, $3)`, [
      listingId,
      newPrice,
      newCurrency,
    ])
  } catch (err) {
    logger.warn(
      `listing ${listingId} price-history write failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
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
//     via the same storeListingPhotos used at initial collection (not
//     duplicated), overwriting primary_photo_url/stored_photo_urls/
//     source_photo_ids together. A total re-fetch failure (all photos
//     unreachable) leaves the existing good copies untouched rather than
//     wiping them - it'll just look "changed" again next check and retry.
export async function refreshListingFields(
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  storedPhotoIds: string[] | null,
  listing: Record<string, unknown>,
  fetchBytes: FetchBytes = defaultFetchBytes,
  compress: CompressImage = defaultCompressImage,
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
      await deleteListingPhotos(imageStore, logger, f.id)
      const newUrls = await storeListingPhotos(imageStore, logger, f.id, listing.listing_photos, fetchBytes, compress)
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

// JS-side twin of PLACEHOLDER_PRICE_SQL above, for callers (checkListingDiscount)
// that already have the price as a JS number and don't need a SQL round trip.
const ASCENDING_RUN_RE = /012|123|234|345|456|567|678|789/
function isPlaceholderPrice(price: number): boolean {
  const digits = String(Math.trunc(Math.abs(price)))
  if (digits.length < 3) return false
  if (/^(\d+)\1+$/.test(digits)) return true
  return ASCENDING_RUN_RE.test(digits)
}

// Loose SQL pre-filter for "the description names a price": any currency/
// keyword-prefixed number, or a k-abbreviated one. Deliberately over-matches
// - descriptionPriceDiverges (JS) does the precise extraction and the 5x
// divergence check on the rows this lets through.
const DESCRIPTION_MENTIONS_PRICE_SQL = `(
  l.description ~* '(₱|php|price|asking|presyo|selling|srp)[^0-9₱]{0,6}[0-9]'
  OR l.description ~* '[0-9][ ]?k\\y'
)`

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
    `WITH product_medians AS (
       SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price
       FROM listings
       WHERE product_id IS NOT NULL AND price_amount IS NOT NULL AND price_amount > 0
         AND NOT ${PLACEHOLDER_PRICE_SQL('price_amount')}
       GROUP BY product_id
     ),
     flagged AS (
       SELECT l.id, l.title, l.description, l.price_amount,
         (l.price_amount < m.median_price / 5 OR l.price_amount > m.median_price * 5) AS price_outlier,
         ${PLACEHOLDER_PRICE_SQL('l.price_amount')} AS placeholder_price,
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
async function flagNegotiableFromKeywords(
  db: DbClient,
  listingId: string,
  title: string | null,
  description: string | null,
): Promise<void> {
  const matched = matchesNegotiableKeyword(title, description)
  if (!matched) return
  await upsertKeywordNegotiable(db, listingId, matched)
}

export interface DiscountPolicyThresholds {
  highDiscountThresholdPercent: number
  minProfitPesos: number
  minPricePesos: number
}

// Operator-tunable via the dashboard Settings page (discount_policy.* keys,
// src/platform/settings.ts) - callers load live values with loadSettings
// and pass them through explicitly; these are just the fallback defaults
// (also the settings table's seed values, db/schema.sql) for callers that
// don't pass thresholds at all (e.g. direct test calls).
export const DEFAULT_DISCOUNT_POLICY: DiscountPolicyThresholds = {
  // Bar for a bell-worthy notification, deliberately higher than the
  // dashboard's 10% discount-badge floor (DISCOUNT_SUMMARY_LATERAL) - a
  // notification is a stronger claim than a badge, per direct instruction.
  highDiscountThresholdPercent: 30,
  // A high % on a cheap item isn't a meaningful opportunity (₱150 item at
  // 50% off is only ₱75 profit) - the absolute peso gap must also clear
  // this bar, independent of the percent threshold.
  minProfitPesos: 1000,
  // Below this, the item isn't worth chasing regardless of discount%/profit
  // math - also the regime where a vague base_model (Bikini, Books, Boys'
  // Clothes) gets matched against a wildly wrong reference price and
  // produces a noisy, not-actually-real "deal" (confirmed live 2026-08-31:
  // several ₱50-150 listings cleared both the discount% and profit bars on
  // stale reference prices alone). Deliberately well below minProfitPesos's
  // own ₱1,000 bar, not equal to it - a ₱500 item reselling at ₱1,500 is a
  // real ₱1,000-profit flip and shouldn't be excluded just for being cheap
  // up front; this floor exists to catch junk-tier noise, not to require
  // the item itself be expensive.
  minPricePesos: 500,
}

// Same raw-median -> clean-median formula as the dashboard's
// DISCOUNT_SUMMARY_LATERAL (dashboard/src/lib/queries.ts), scoped to one
// product - the fallback reference for checkListingDiscount below when real
// secondhand market data isn't available yet. Returns null (not 0) when
// there aren't at least 2 comparable sibling listings, same "nothing to
// compare against" case the dashboard's own version handles.
async function getPeerMedianPrice(db: DbClient, productId: number): Promise<number | null> {
  const result = (await db.query(
    `WITH product_prices AS (
       SELECT pl.price_amount
       FROM listings pl
       JOIN products p ON p.id = pl.product_id
       WHERE pl.product_id = $1 AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
         AND NOT p.price_lookup_excluded
         AND NOT ${PLACEHOLDER_PRICE_SQL('pl.price_amount')}
     ),
     raw AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
       FROM product_prices
     )
     SELECT
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
        FROM product_prices pp, raw
        WHERE raw.n >= 2 AND raw.median_price > 0
          AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10) AS clean_median_price
     FROM raw`,
    [productId],
  )) as { rows: { clean_median_price: string | null }[] }
  const value = result.rows[0]?.clean_median_price
  return value ? Number(value) : null
}

// "used" wins outright over "new" - "Used - like new" contains "new" but is
// never actually new-in-box. Same fix as discount-verification.ts's
// isNewCondition, duplicated here rather than imported (that module isn't
// committed yet as of 2026-08-31, and this is a small enough pure function
// that duplication is cheaper than the coupling).
function isNewCondition(condition: string | null): boolean {
  if (condition === null) return false
  const lower = condition.toLowerCase()
  if (lower.includes('used')) return false
  return lower.includes('new')
}

// Real-market-price-first discount check for a single listing, called
// inline right after its product has (or already had) retail/secondhand
// pricing ensured in extract-products.ts - the "trigger is retail pricing
// becoming available" design (2026-08-31), replacing the old
// batch-of-siblings-only check that could never fire on a product's first
// listing.
//
// Priority: secondhand (real market data) for any non-"New" listing - only
// falls back to peer-comparison (median of this product's own listings)
// when secondhand isn't available yet. "New" listings always compare
// against retail; a "New" listing is never passed here without a retail
// price already in hand (see ensureProductPriced's exclude-on-retail-miss
// behavior - a product with no retail was already excluded before this
// function would ever be called). ON CONFLICT (listing_id) DO NOTHING
// enforces "at most one notification per listing ever," same as before.
export async function checkListingDiscount(
  db: DbClient,
  listingId: string,
  productId: number,
  condition: string | null,
  priceAmount: number | null,
  retailPrice: PriceRange | null,
  secondhandPrice: PriceRange | null,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<void> {
  if (priceAmount === null || priceAmount <= 0) return
  if (priceAmount < thresholds.minPricePesos) return
  if (isPlaceholderPrice(priceAmount)) return

  let referencePrice: number | null
  if (isNewCondition(condition)) {
    referencePrice = retailPrice ? retailPrice.low : null
  } else if (secondhandPrice) {
    referencePrice = secondhandPrice.low
  } else {
    referencePrice = await getPeerMedianPrice(db, productId)
  }

  if (referencePrice === null || referencePrice <= 0) return
  if (priceAmount < referencePrice / 10 || priceAmount > referencePrice * 10) return // same magnitude-outlier guard as elsewhere

  const discountPercent = Math.round(((referencePrice - priceAmount) / referencePrice) * 100)
  const profitPesos = referencePrice - priceAmount
  if (discountPercent < thresholds.highDiscountThresholdPercent || profitPesos < thresholds.minProfitPesos) return

  await db.query(
    `INSERT INTO discount_notifications (listing_id, product_id, discount_percent, reference_price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (listing_id) DO NOTHING`,
    [listingId, productId, discountPercent, referencePrice],
  )
}

export interface DiscountVerificationCandidate {
  id: number
  listing_id: string
  title: string | null
  description: string | null
  condition: string | null
  price_amount: number
  base_model: string
  is_specific_product: boolean | null
}

// Pending = verified_at IS NULL. Backoff (1hr) on last_verification_attempt_at
// keeps a candidate stuck on a transient failure (network blip, all 3 price
// providers down at once) from re-burning a paid Tavily/Exa call every
// verify-discount-notifications.ts loop tick (every 5 min). Oldest-flagged
// first, same "work down the backlog in order" idiom as getCheckListingsCandidates.
// Excludes a candidate whose product has no enrichment judgment yet UNLESS
// its price already fails minPricePesos - that gate needs no enrichment
// data at all (precheckDiscountCandidate checks it first), so it still
// resolves for free/instantly. Everything else waiting on real enrichment
// is left alone entirely: not fetched, not attempted, no log noise, no
// last_verification_attempt_at write - it'll show up here on its own the
// moment enrich-products actually judges it (per direct instruction,
// 2026-08-31: "don't process it at all since enrichment is still pending").
// minPricePesos must be kept in sync with whatever precheckDiscountCandidate
// is using this lap - the caller (verify-discount-notifications) loads both
// from the same settings read to guarantee that.
export async function getUnverifiedDiscountCandidates(
  db: DbClient,
  limit: number,
  minPricePesos: number = DEFAULT_DISCOUNT_POLICY.minPricePesos,
): Promise<DiscountVerificationCandidate[]> {
  const result = (await db.query(
    `SELECT dn.id, dn.listing_id, l.title, l.description, l.condition, l.price_amount,
            p.base_model, pe.is_specific_product
     FROM discount_notifications dn
     JOIN listings l ON l.id = dn.listing_id
     JOIN products p ON p.id = dn.product_id
     LEFT JOIN product_enrichment pe ON pe.product_id = dn.product_id
     WHERE dn.verified_at IS NULL
       AND (dn.last_verification_attempt_at IS NULL OR dn.last_verification_attempt_at < now() - interval '1 hour')
       AND (pe.is_specific_product IS NOT NULL OR l.price_amount < $2)
     ORDER BY dn.created_at ASC
     LIMIT $1`,
    [limit, minPricePesos],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: Number(r.id),
    listing_id: r.listing_id as string,
    title: r.title as string | null,
    description: r.description as string | null,
    condition: r.condition as string | null,
    price_amount: Number(r.price_amount),
    base_model: r.base_model as string,
    is_specific_product: r.is_specific_product as boolean | null,
  }))
}

export interface DiscountVerificationOutcome {
  discountPercent: number
  referencePrice: number
  source: string
  reasoning: string
}

// discount_percent/reference_price are overwritten with the fresh verified
// numbers, not left as the original stale-median detection values - the
// dashboard should show what verification actually confirmed, same
// transparency as listing_price_review overwriting the displayed price.
export async function markDiscountNotificationVerified(
  db: DbClient,
  id: number,
  data: DiscountVerificationOutcome,
): Promise<void> {
  await db.query(
    `UPDATE discount_notifications
     SET verified_at = now(), discount_percent = $2, reference_price = $3,
         verification_source = $4, verification_reasoning = $5
     WHERE id = $1`,
    [id, data.discountPercent, data.referencePrice, data.source, data.reasoning],
  )
}

// A definitive rejection (any check says no) deletes the row outright rather
// than flagging a status - each listing only ever gets one candidate row
// ever (see the table's UNIQUE(listing_id)), so there's nothing to leave a
// tombstone for, and this doubles as "never notify, never retry."
export async function rejectDiscountNotification(db: DbClient, id: number): Promise<void> {
  await db.query(`DELETE FROM discount_notifications WHERE id = $1`, [id])
}

// A transient failure (all price providers/Groq errored) - stays pending,
// only the attempt timestamp moves, so getUnverifiedDiscountCandidates'
// backoff window kicks in for this row without ever marking it verified.
export async function markDiscountNotificationAttempted(db: DbClient, id: number): Promise<void> {
  await db.query(`UPDATE discount_notifications SET last_verification_attempt_at = now() WHERE id = $1`, [id])
}
