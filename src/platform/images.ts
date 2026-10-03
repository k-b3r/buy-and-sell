import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import type { Logger } from './logger'

export interface ImageStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<string>
  deleteAll(prefix: string): Promise<void>
}

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  publicBaseUrl: string
}

export function createR2ImageStore(config: R2Config): ImageStore {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }))
      return `${config.publicBaseUrl}/${key}`
    },
    async deleteAll(prefix) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }))
      const keys = (listed.Contents ?? []).flatMap((obj) => (obj.Key ? [{ Key: obj.Key }] : []))
      if (keys.length === 0) return
      await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys } }))
    },
  }
}

export type FetchBytes = (url: string) => Promise<{ body: Uint8Array; contentType: string } | null>

export const defaultFetchBytes: FetchBytes = async (url) => {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const body = new Uint8Array(await res.arrayBuffer())
    return { body, contentType }
  } catch {
    // network-level failure (DNS, timeout, connection reset, etc.) — treat
    // the same as a bad HTTP response, skip this one photo rather than
    // crashing the whole run over a single flaky CDN fetch.
    return null
  }
}

function extensionFor(contentType: string): string {
  return contentType.includes('png') ? 'png' : 'jpg'
}

export type CompressImage = (
  body: Uint8Array,
  contentType: string,
) => Promise<{ body: Uint8Array; contentType: string }>

// Facebook's originals are already ~720px wide, so the size win comes mostly
// from re-encoding at a lower JPEG quality rather than downscaling further.
// 800px cap is a no-op for these but guards against the rare oversized photo.
export const defaultCompressImage: CompressImage = async (body) => {
  const output = await sharp(body).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
  return { body: new Uint8Array(output), contentType: 'image/jpeg' }
}

// Facebook's CDN URLs on listing_photos are signed and expire in days, so bytes
// are downloaded and re-hosted at collection time rather than storing the URL
// alone. A single broken photo shouldn't fail the whole listing — skipped and
// logged instead.
export async function storeListingPhotos(
  store: ImageStore,
  logger: Logger,
  listingId: string,
  photos: unknown,
  fetchBytes: FetchBytes = defaultFetchBytes,
  compress: CompressImage = defaultCompressImage,
): Promise<string[]> {
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
}

export async function deleteListingPhotos(store: ImageStore, logger: Logger, listingId: string): Promise<void> {
  await store.deleteAll(`listings/${listingId}/`)
  logger.info(`deleted photos for listing ${listingId}`)
}
