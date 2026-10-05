import type { CompressImage, FetchBytes, ImageStore } from '../../platform/images'
import type { Logger } from '../../platform/logger'

// A listing's re-hosted photo carousel, stored under listings/<id>/. Built once
// per entry point from platform/images' real I/O (createR2ImageStore,
// defaultFetchBytes, defaultCompressImage) so this module, and so its index,
// never loads sharp or the S3 SDK.
export interface ListingPhotos {
  // Returns the public URLs of the photos that made it, in carousel order.
  save(listingId: string, photos: unknown): Promise<string[]>
  deleteAll(listingId: string): Promise<void>
}

export interface ListingPhotosIo {
  store: ImageStore
  fetchBytes: FetchBytes
  compress: CompressImage
  logger: Logger
}

function extensionFor(contentType: string): string {
  return contentType.includes('png') ? 'png' : 'jpg'
}

export function createListingPhotos({ store, fetchBytes, compress, logger }: ListingPhotosIo): ListingPhotos {
  return {
    // Facebook's CDN URLs on listing_photos are signed and expire in days, so bytes
    // are downloaded and re-hosted at collection time rather than storing the URL
    // alone. A single broken photo shouldn't fail the whole listing — skipped and
    // logged instead.
    async save(listingId, photos) {
      if (!Array.isArray(photos)) return []
      const urls: string[] = []
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
        const key = `listings/${listingId}/${i}.${extensionFor(stored.contentType)}`
        const url = await store.put(key, stored.body, stored.contentType)
        urls.push(url)
      }
      return urls
    },
    async deleteAll(listingId) {
      await store.deleteAll(`listings/${listingId}/`)
      logger.info(`deleted photos for listing ${listingId}`)
    },
  }
}
