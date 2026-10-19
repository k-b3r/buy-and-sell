import type { ListingFields } from '../types'

function extractField(listing: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (listing[key] !== undefined && listing[key] !== null) return listing[key]
  }
  return null
}

// Shared by upsertListing (full insert/refresh, including photos) and
// refreshListingFields (text/price-only refresh) so the two can't drift on
// how a raw Facebook listing object gets parsed.
export function parseListingFields(listing: Record<string, unknown>): ListingFields {
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

function parsePrice(listing: Record<string, unknown>): Pick<ListingFields, 'priceAmount' | 'priceCurrency'> {
  const priceObj = listing.listing_price as { amount?: string; currency?: string } | undefined
  return {
    priceAmount: priceObj?.amount !== undefined ? Number(priceObj.amount) : null,
    priceCurrency: priceObj?.currency ?? null,
  }
}

function parseDetails(
  listing: Record<string, unknown>,
): Pick<ListingFields, 'description' | 'condition' | 'categoryId'> {
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
): Pick<ListingFields, 'locationLat' | 'locationLng' | 'locationCity'> {
  const location = listing.location as
    { latitude?: number; longitude?: number; reverse_geocode?: { city?: string } } | undefined
  return {
    locationLat: location?.latitude ?? null,
    locationLng: location?.longitude ?? null,
    locationCity: location?.reverse_geocode?.city ?? null,
  }
}

function parsePhotos(listing: Record<string, unknown>): Pick<ListingFields, 'primaryPhotoUrl' | 'storedPhotoUrls'> {
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
export function extractPhotoIds(listing: Record<string, unknown>): string[] | null {
  const photos = listing.listing_photos
  if (!Array.isArray(photos)) return null
  return photos.map((p) => (p as { id?: unknown } | undefined)?.id).filter((id): id is string => typeof id === 'string')
}

export function photoIdsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
