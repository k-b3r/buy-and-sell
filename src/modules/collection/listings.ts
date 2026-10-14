import type { DbClient } from '../../platform/storage'
import type { Logger } from '../../platform/logger'
import type { PriorPriceRow } from '../real-estate'
import { recordRealEstatePriceChange } from '../real-estate'
import type { ListingPhotos } from './photos'
import type { CheckListingsCandidate } from './store/listings'
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
  const creationTime = listing.creation_time as number | undefined
  return {
    id: String(listing.id),
    title: extractField(listing, 'marketplace_listing_title', 'custom_title') as string | null,
    ...parsePrice(listing),
    ...parseDetails(listing),
    ...parseLocation(listing),
    ...parsePhotos(listing),
    listedAt: creationTime ? new Date(creationTime * 1000) : null,
  }
}

function parsePrice(listing: Record<string, unknown>): Pick<ParsedListingFields, 'priceAmount' | 'priceCurrency'> {
  const priceObj = listing.listing_price as { amount?: string; currency?: string } | undefined
  return {
    priceAmount: priceObj?.amount !== undefined ? Number(priceObj.amount) : null,
    priceCurrency: priceObj?.currency ?? null,
  }
}

function parseDetails(
  listing: Record<string, unknown>,
): Pick<ParsedListingFields, 'description' | 'condition' | 'categoryId'> {
  // Facebook nests condition inside attribute_data (an array of {label, value,
  // attribute_name} entries covering Condition, Brand, etc.), not a top-level
  // "condition" field — confirmed live, 97% of real listings have it here.
  const attributeData = listing.attribute_data as { label?: string; attribute_name?: string }[] | undefined
  return {
    description: (listing.redacted_description as { text?: string } | undefined)?.text ?? null,
    condition: attributeData?.find((a) => a.attribute_name === 'Condition')?.label ?? null,
    categoryId: (listing.marketplace_listing_category_id as string | undefined) ?? null,
  }
}

function parseLocation(
  listing: Record<string, unknown>,
): Pick<ParsedListingFields, 'locationLat' | 'locationLng' | 'locationCity'> {
  const location = listing.location as
    { latitude?: number; longitude?: number; reverse_geocode?: { city?: string } } | undefined
  return {
    locationLat: location?.latitude ?? null,
    locationLng: location?.longitude ?? null,
    locationCity: location?.reverse_geocode?.city ?? null,
  }
}

function parsePhotos(
  listing: Record<string, unknown>,
): Pick<ParsedListingFields, 'primaryPhotoUrl' | 'storedPhotoUrls'> {
  return {
    primaryPhotoUrl: (listing.primary_listing_photo as { image?: { uri?: string } } | undefined)?.image?.uri ?? null,
    storedPhotoUrls: (listing.stored_photo_urls as string[] | undefined) ?? null,
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

export function putDealsFirst(
  deals: CheckListingsCandidate[],
  backlog: CheckListingsCandidate[],
  limit: number,
): CheckListingsCandidate[] {
  const dealIds = new Set(deals.map((d) => d.id))
  return [...deals, ...backlog.filter((c) => !dealIds.has(c.id))].slice(0, limit)
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
//     via ListingPhotos.replace (the same save used at initial collection,
//     plus deleting the keys the new set no longer uses), overwriting primary_photo_url/stored_photo_urls/
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

  let pruneUnusedPhotos = async (): Promise<void> => {}
  if (currentPhotoIds !== null) {
    if (storedPhotoIds === null) {
      params.push(JSON.stringify(currentPhotoIds))
      setClauses.push(`source_photo_ids = $${params.length}`)
    } else if (!photoIdsEqual(currentPhotoIds, storedPhotoIds)) {
      logger.info(`listing ${f.id} photos changed since last check, re-fetching`)
      // No deleteAll first: replace writes deterministic keys (listings/<id>/<i>),
      // so new photos overwrite old ones in place, leftovers are pruned only
      // after the UPDATE below succeeded, and a re-fetch that gets nothing
      // leaves the stored photos the DB points at intact.
      const replaced = await photos.replace(f.id, listing.listing_photos)
      const newUrls = replaced.urls
      pruneUnusedPhotos = replaced.pruneUnused
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

  const setSql = setClauses.join(', ')
  const updated = (await db.query(
    `UPDATE listings SET ${setSql}
     FROM (SELECT price_amount AS old_price_amount, price_currency AS old_price_currency, first_seen_at AS old_first_seen_at
           FROM listings WHERE id = $1) prev
     WHERE listings.id = $1
     RETURNING prev.old_price_amount, prev.old_price_currency, prev.old_first_seen_at`,
    params,
  )) as { rows?: PriorPriceRow[] } | undefined
  await pruneUnusedPhotos()
  await recordRealEstatePriceChange(db, logger, {
    listingId: f.id,
    prior: updated?.rows?.[0],
    newPrice: f.priceAmount,
    newCurrency: f.priceCurrency,
  })
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
}
