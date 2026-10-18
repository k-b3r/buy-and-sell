import type { DbClient } from '../../../platform/storage'
import type { Logger } from '../../../platform/logger'
import { recordRealEstatePriceChange } from '../../real-estate'
import { extractPhotoIds, parseListingFields, photoIdsEqual } from '../domain/listing-fields'
import type { ListingPhotos } from '../types'
import type { PhotoUpdate } from '../store/listings'
import { updateListingFields, upsertListingRow } from '../store/listings'
// Negotiable-keyword flagging is pricing's rule, run on every listing write.
import { flagNegotiableFromKeywords } from '../../pricing'

export async function upsertListing(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)
  const photoIds = extractPhotoIds(listing)

  await upsertListingRow(db, f, photoIds, listing)
  await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
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
