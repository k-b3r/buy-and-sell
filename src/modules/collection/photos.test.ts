import type { Logger } from '../../platform/logger'
import type { ImageStore, FetchBytes, CompressImage } from '../../platform/images'
import { createListingPhotos } from './photos'

// Identity pass-through — real compression (sharp) is exercised in
// platform/images.test.ts; these tests only care about the download/store
// orchestration.
const identityCompress: CompressImage = async (body, contentType) => ({ body, contentType })
const unusedFetchBytes: FetchBytes = async () => null

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  }
}

function fakeStore(existingKeys: string[] = []): ImageStore & {
  puts: { key: string; contentType: string }[]
  deletedPrefixes: string[]
  deletedKeys: string[]
  keys: Set<string>
} {
  const puts: { key: string; contentType: string }[] = []
  const deletedPrefixes: string[] = []
  const deletedKeys: string[] = []
  const keys = new Set(existingKeys)
  return {
    puts,
    deletedPrefixes,
    deletedKeys,
    keys,
    async put(key, _body, contentType) {
      puts.push({ key, contentType })
      keys.add(key)
      return `https://images.example.com/${key}`
    },
    async deleteAll(prefix) {
      deletedPrefixes.push(prefix)
    },
    async list(prefix) {
      return [...keys].filter((key) => key.startsWith(prefix))
    },
    async delete(key) {
      deletedKeys.push(key)
      keys.delete(key)
    },
  }
}

const jpegFetchBytes: FetchBytes = async () => ({ body: new Uint8Array([1]), contentType: 'image/jpeg' })

function carousel(count: number): { image: { uri: string } }[] {
  return Array.from({ length: count }, (_, i) => ({ image: { uri: `https://cdn.example.com/${i}.jpg` } }))
}

test('downloads and stores each photo in the carousel, returning public URLs in order', async () => {
  const store = fakeStore()
  const fetchBytes: FetchBytes = async (url) => ({
    body: new Uint8Array([1, 2, 3]),
    contentType: url.includes('png') ? 'image/png' : 'image/jpeg',
  })
  const photos = [
    { image: { uri: 'https://cdn.example.com/a.jpg' } },
    { image: { uri: 'https://cdn.example.com/b.png' } },
  ]
  const listingPhotos = createListingPhotos({ store, fetchBytes, compress: identityCompress, logger: fakeLogger() })

  const urls = await listingPhotos.save('111', photos)

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
  const listingPhotos = createListingPhotos({ store, fetchBytes, compress: identityCompress, logger })

  const urls = await listingPhotos.save('111', photos)

  expect(urls).toEqual(['https://images.example.com/listings/111/1.jpg'])
  expect(logger.warnings).toEqual(['failed to download photo 0 for listing 111, skipping'])
})

test('stores the original bytes when compression fails', async () => {
  const store = fakeStore()
  const logger = fakeLogger()
  const fetchBytes: FetchBytes = async () => ({ body: new Uint8Array([1]), contentType: 'image/png' })
  const failingCompress: CompressImage = async () => {
    throw new Error('corrupt image')
  }
  const listingPhotos = createListingPhotos({ store, fetchBytes, compress: failingCompress, logger })

  const urls = await listingPhotos.save('111', [{ image: { uri: 'https://cdn.example.com/a.png' } }])

  expect(urls).toEqual(['https://images.example.com/listings/111/0.png'])
  expect(logger.warnings).toEqual(['failed to compress photo 0 for listing 111, storing original'])
})

test('returns an empty array when there is no photo carousel', async () => {
  const store = fakeStore()
  const listingPhotos = createListingPhotos({
    store,
    fetchBytes: unusedFetchBytes,
    compress: identityCompress,
    logger: fakeLogger(),
  })

  expect(await listingPhotos.save('111', undefined)).toEqual([])
  expect(await listingPhotos.save('111', 'not-an-array')).toEqual([])
  expect(store.puts).toEqual([])
})

test("deleteAll deletes everything under the listing's own key prefix", async () => {
  const store = fakeStore()
  const listingPhotos = createListingPhotos({
    store,
    fetchBytes: unusedFetchBytes,
    compress: identityCompress,
    logger: fakeLogger(),
  })

  await listingPhotos.deleteAll('111')

  expect(store.deletedPrefixes).toEqual(['listings/111/'])
})

test('replace saves the new set and its pruneUnused deletes the stored photos the smaller set no longer uses', async () => {
  const store = fakeStore(['listings/111/0.jpg', 'listings/111/1.jpg', 'listings/111/2.jpg', 'listings/222/0.jpg'])
  const listingPhotos = createListingPhotos({
    store,
    fetchBytes: jpegFetchBytes,
    compress: identityCompress,
    logger: fakeLogger(),
  })

  const { urls, pruneUnused } = await listingPhotos.replace('111', carousel(1))
  expect(store.deletedKeys).toEqual([])
  await pruneUnused()

  expect(urls).toEqual(['https://images.example.com/listings/111/0.jpg'])
  expect(store.deletedKeys).toEqual(['listings/111/1.jpg', 'listings/111/2.jpg'])
  expect([...store.keys].sort()).toEqual(['listings/111/0.jpg', 'listings/222/0.jpg'])
})

test('replace deletes the old object when a photo is re-stored under a different extension', async () => {
  const store = fakeStore(['listings/111/0.png'])
  const listingPhotos = createListingPhotos({
    store,
    fetchBytes: jpegFetchBytes,
    compress: identityCompress,
    logger: fakeLogger(),
  })

  await (await listingPhotos.replace('111', carousel(1))).pruneUnused()

  expect(store.deletedKeys).toEqual(['listings/111/0.png'])
})

test('replace deletes nothing when the new set fails to download entirely', async () => {
  const store = fakeStore(['listings/111/0.jpg', 'listings/111/1.jpg'])
  const listingPhotos = createListingPhotos({
    store,
    fetchBytes: unusedFetchBytes,
    compress: identityCompress,
    logger: fakeLogger(),
  })

  const { urls, pruneUnused } = await listingPhotos.replace('111', carousel(1))
  await pruneUnused()

  expect(urls).toEqual([])
  expect(store.deletedKeys).toEqual([])
})

test('replace logs a failed orphan delete with listing id and key and keeps deleting the rest', async () => {
  const store = fakeStore(['listings/111/0.jpg', 'listings/111/1.jpg', 'listings/111/2.jpg'])
  const deleteKey = store.delete
  store.delete = async (key) => {
    if (key === 'listings/111/1.jpg') throw new Error('R2 unavailable')
    await deleteKey(key)
  }
  const logger = fakeLogger()
  const listingPhotos = createListingPhotos({ store, fetchBytes: jpegFetchBytes, compress: identityCompress, logger })

  await (await listingPhotos.replace('111', carousel(1))).pruneUnused()

  expect(store.deletedKeys).toEqual(['listings/111/2.jpg'])
  expect(logger.warnings).toEqual([
    'failed to delete orphaned photo listings/111/1.jpg for listing 111: R2 unavailable',
  ])
})

test('pruneUnused logs and gives up when listing the stored photos fails', async () => {
  const store = fakeStore(['listings/111/1.jpg'])
  store.list = async () => {
    throw new Error('R2 unavailable')
  }
  const logger = fakeLogger()
  const listingPhotos = createListingPhotos({ store, fetchBytes: jpegFetchBytes, compress: identityCompress, logger })

  await (await listingPhotos.replace('111', carousel(1))).pruneUnused()

  expect(store.deletedKeys).toEqual([])
  expect(logger.warnings).toEqual(['failed to list stored photos for listing 111, orphans kept: R2 unavailable'])
})
