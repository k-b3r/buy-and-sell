import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

export interface ImageStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<string>
  deleteAll(prefix: string): Promise<void>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
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
    // One page (up to 1000 keys) is plenty: callers list a single listing's prefix.
    async list(prefix) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }))
      return (listed.Contents ?? []).flatMap((obj) => (obj.Key ? [obj.Key] : []))
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
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
