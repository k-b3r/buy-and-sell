import { summarizeError } from '../../platform/errors'
import type { CompressImage, FetchBytes, ImageStore } from '../../platform/images'
import type { Logger } from '../../platform/logger'

// A listing's re-hosted photo carousel, stored under listings/<id>/. Built once
// per entry point from platform/images' real I/O (createR2ImageStore,
// defaultFetchBytes, defaultCompressImage) so this module, and so its index,
// never loads sharp or the S3 SDK.
export interface ListingPhotos {
  // Returns the public URLs of the photos that made it, in carousel order.
  save(listingId: string, photos: unknown): Promise<string[]>
  // save, then delete the listing's stored objects the new set no longer uses
  // (fewer photos, or a photo whose extension changed). Nothing is deleted
  // when the new set saved nothing, and a failed delete is logged, never thrown.
  replace(listingId: string, photos: unknown): Promise<string[]>
  deleteAll(listingId: string): Promise<void>
}

export interface ListingPhotosIo {
  store: ImageStore
  fetchBytes: FetchBytes
  compress: CompressImage
  logger: Logger
}

interface StoredPhoto {
  key: string
  url: string
}

function extensionFor(contentType: string): string {
  return contentType.includes('png') ? 'png' : 'jpg'
}

function prefixFor(listingId: string): string {
  return `listings/${listingId}/`
}

export function createListingPhotos({ store, fetchBytes, compress, logger }: ListingPhotosIo): ListingPhotos {
  // Facebook's CDN URLs on listing_photos are signed and expire in days, so bytes
  // are downloaded and re-hosted at collection time rather than storing the URL
  // alone. A single broken photo shouldn't fail the whole listing — skipped and
  // logged instead.
  async function storeAll(listingId: string, photos: unknown): Promise<StoredPhoto[]> {
    if (!Array.isArray(photos)) return []
    const saved: StoredPhoto[] = []
    for (let i = 0; i < photos.length; i++) {
      const uri = (photos[i] as { image?: { uri?: string } } | undefined)?.image?.uri
      if (typeof uri !== 'string') continue
      const fetched = await fetchBytes(uri)
      if (!fetched) {
        logger.warn(`failed to download photo ${i} for listing ${listingId}, skipping`)
        continue
      }
      let stored: { body: Uint8Array; contentType: string }
      try {
        stored = await compress(fetched.body, fetched.contentType)
      } catch {
        logger.warn(`failed to compress photo ${i} for listing ${listingId}, storing original`)
        stored = fetched
      }
      const key = `${prefixFor(listingId)}${i}.${extensionFor(stored.contentType)}`
      const url = await store.put(key, stored.body, stored.contentType)
      saved.push({ key, url })
    }
    return saved
  }

  // Orphans are only wasted storage, so a failure here is logged and the
  // refresh carries on; the leftovers go with the listing's deleteAll later.
  async function deleteUnused(listingId: string, keep: Set<string>): Promise<void> {
    let existing: string[]
    try {
      existing = await store.list(prefixFor(listingId))
    } catch (err) {
      logger.warn(`failed to list stored photos for listing ${listingId}, orphans kept: ${summarizeError(err)}`)
      return
    }
    for (const key of existing) {
      if (keep.has(key)) continue
      try {
        await store.delete(key)
      } catch (err) {
        logger.warn(`failed to delete orphaned photo ${key} for listing ${listingId}: ${summarizeError(err)}`)
      }
    }
  }

  return {
    async save(listingId, photos) {
      return (await storeAll(listingId, photos)).map((photo) => photo.url)
    },
    async replace(listingId, photos) {
      const saved = await storeAll(listingId, photos)
      if (saved.length > 0) await deleteUnused(listingId, new Set(saved.map((photo) => photo.key)))
      return saved.map((photo) => photo.url)
    },
    async deleteAll(listingId) {
      await store.deleteAll(prefixFor(listingId))
      logger.info(`deleted photos for listing ${listingId}`)
    },
  }
}
