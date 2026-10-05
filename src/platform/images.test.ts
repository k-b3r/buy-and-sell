import sharp from 'sharp'
import { defaultCompressImage, defaultFetchBytes } from './images'

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
