import sharp from 'sharp'
import type { Logger } from './logger'
import type { ImageStore, FetchBytes, CompressImage } from './images'
import { storeListingPhotos, defaultCompressImage, defaultFetchBytes, deleteListingPhotos } from './images'

// Identity pass-through — real compression (sharp) is exercised separately;
// these tests only care about the download/store orchestration.
const identityCompress: CompressImage = async (body, contentType) => ({ body, contentType })

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  }
}

function fakeStore(): ImageStore & { puts: { key: string; contentType: string }[]; deletedPrefixes: string[] } {
  const puts: { key: string; contentType: string }[] = []
  const deletedPrefixes: string[] = []
  return {
    puts,
    deletedPrefixes,
    async put(key, _body, contentType) {
      puts.push({ key, contentType })
      return `https://images.example.com/${key}`
    },
    async deleteAll(prefix) {
      deletedPrefixes.push(prefix)
    },
  }
}

test('downloads and stores each photo in the carousel, returning public URLs in order', async () => {
  const store = fakeStore()
  const logger = fakeLogger()
  const fetchBytes: FetchBytes = async (url) => ({
    body: new Uint8Array([1, 2, 3]),
    contentType: url.includes('png') ? 'image/png' : 'image/jpeg',
  })
  const photos = [
    { image: { uri: 'https://cdn.example.com/a.jpg' } },
    { image: { uri: 'https://cdn.example.com/b.png' } },
  ]

  const urls = await storeListingPhotos(store, logger, '111', photos, fetchBytes, identityCompress)

  expect(urls).toEqual([
    'https://images.example.com/listings/111/0.jpg',
    'https://images.example.com/listings/111/1.png',
  ])
  expect(store.puts).toEqual([
    { key: 'listings/111/0.jpg', contentType: 'image/jpeg' },
    { key: 'listings/111/1.png', contentType: 'image/png' },
  ])
})

test('skips a photo that fails to download without failing the rest', async () => {
  const store = fakeStore()
  const logger = fakeLogger()
  const fetchBytes: FetchBytes = async (url) =>
    url.includes('broken') ? null : { body: new Uint8Array([1]), contentType: 'image/jpeg' }
  const photos = [
    { image: { uri: 'https://cdn.example.com/broken.jpg' } },
    { image: { uri: 'https://cdn.example.com/ok.jpg' } },
  ]

  const urls = await storeListingPhotos(store, logger, '111', photos, fetchBytes, identityCompress)

  expect(urls).toEqual(['https://images.example.com/listings/111/1.jpg'])
  expect(logger.warnings).toEqual(['failed to download photo 0 for listing 111, skipping'])
})

test('defaultCompressImage re-encodes to a smaller jpeg without changing dimensions much', async () => {
  const original = await sharp({
    create: { width: 720, height: 960, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg({ quality: 100 })
    .toBuffer()

  const { body, contentType } = await defaultCompressImage(new Uint8Array(original), 'image/jpeg')

  expect(contentType).toBe('image/jpeg')
  expect(body.byteLength).toBeLessThan(original.byteLength)
  const meta = await sharp(Buffer.from(body)).metadata()
  expect(meta.width).toBeLessThanOrEqual(800)
})

test('defaultFetchBytes returns null instead of throwing on a network-level failure', async () => {
  const originalFetch = global.fetch
  global.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch

  const result = await defaultFetchBytes('https://cdn.example.com/unreachable.jpg')

  global.fetch = originalFetch
  expect(result).toBeNull()
})

test('returns an empty array when there is no photo carousel', async () => {
  const store = fakeStore()
  const logger = fakeLogger()

  expect(await storeListingPhotos(store, logger, '111', undefined)).toEqual([])
  expect(await storeListingPhotos(store, logger, '111', 'not-an-array')).toEqual([])
  expect(store.puts).toEqual([])
})

test('deleteListingPhotos deletes everything under the listing\'s own key prefix', async () => {
  const store = fakeStore()
  const logger = fakeLogger()

  await deleteListingPhotos(store, logger, '111')

  expect(store.deletedPrefixes).toEqual(['listings/111/'])
})
