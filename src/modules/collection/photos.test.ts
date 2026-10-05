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
