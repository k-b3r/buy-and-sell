import type { DbClient } from '../../storage/client'
import { flagNegotiableFromKeywords } from '../enrich-listing-prices/storage'

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
// check-listings/storage.ts's refreshListingFields (text/price-only refresh)
// so the two can't drift on how a raw Facebook listing object gets parsed -
// exported since it crosses into another worker's storage.
export function parseListingFields(listing: Record<string, unknown>): ParsedListingFields {
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
    | { latitude?: number; longitude?: number; reverse_geocode?: { city?: string } }
    | undefined
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

export async function upsertListing(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)

  await db.query(
    `INSERT INTO listings (
       id, title, price_amount, price_currency, description, condition, category_id,
       location_lat, location_lng, location_city, primary_photo_url, stored_photo_urls, listed_at, raw_json
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
