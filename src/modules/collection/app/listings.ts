import type { DbClient } from '../../../platform/storage'
import type { Logger } from '../../../platform/logger'
import { recordRealEstatePriceChange } from '../../real-estate'
import type { ListingFields, ListingPhotos } from '../types'
import type { CheckListingsCandidate, PhotoUpdate } from '../store/listings'
import { updateListingFields, upsertListingRow } from '../store/listings'
// Negotiable-keyword flagging is pricing's rule, run on every listing write.
import { flagNegotiableFromKeywords } from '../../pricing'

function extractField(listing: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (listing[key] !== undefined && listing[key] !== null) return listing[key]
  }
  return null
}

// Shared by upsertListing (full insert/refresh, including photos) and
// refreshListingFields (text/price-only refresh) so the two can't drift on
// how a raw Facebook listing object gets parsed.
function parseListingFields(listing: Record<string, unknown>): ListingFields {
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

  await upsertListingRow(db, f, photoIds, listing)
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

  let photoUpdate: PhotoUpdate | null = null
  let pruneUnusedPhotos = async (): Promise<void> => {}
  if (currentPhotoIds !== null) {
    if (storedPhotoIds === null) {
      photoUpdate = { kind: 'baseline', sourcePhotoIds: currentPhotoIds }
    } else if (!photoIdsEqual(currentPhotoIds, storedPhotoIds)) {
      logger.info(`listing ${f.id} photos changed since last check, re-fetching`)
      // No deleteAll first: replace writes deterministic keys (listings/<id>/<i>),
      // so new photos overwrite old ones in place, leftovers are pruned only
      // after the UPDATE below succeeded, and a re-fetch that gets nothing
      // leaves the stored photos the DB points at intact.
      const replaced = await photos.replace(f.id, listing.listing_photos)
      pruneUnusedPhotos = replaced.pruneUnused
      if (replaced.urls.length > 0) {
        photoUpdate = {
          kind: 'replace',
          primaryPhotoUrl: f.primaryPhotoUrl,
          storedPhotoUrls: replaced.urls,
          sourcePhotoIds: currentPhotoIds,
        }
      } else {
        logger.warn(`listing ${f.id} photo re-fetch returned nothing, keeping existing photos`)
      }
    }
  }

  const prior = await updateListingFields(db, f, listing, photoUpdate)
  await pruneUnusedPhotos()
  await recordRealEstatePriceChange(db, logger, {
    listingId: f.id,
    prior,
    newPrice: f.priceAmount,
    newCurrency: f.priceCurrency,
  })
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
}
