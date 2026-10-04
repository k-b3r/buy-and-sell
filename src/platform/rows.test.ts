import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from './rows'

test('toNullableNumber coerces numeric strings and keeps null and undefined as null', () => {
  expect(toNullableNumber('13000000.50')).toBe(13000000.5)
  expect(toNullableNumber(7)).toBe(7)
  expect(toNullableNumber(null)).toBeNull()
  expect(toNullableNumber(undefined)).toBeNull()
})

test('toIsoOrNull turns a Date into an ISO string and passes strings and nulls through', () => {
  expect(toIsoOrNull(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01T00:00:00.000Z')
  expect(toIsoOrNull('2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z')
  expect(toIsoOrNull(null)).toBeNull()
  expect(toIsoOrNull(undefined)).toBeNull()
})

test('resolvePhotoUrls prefers stored copies and falls back to the primary photo url', () => {
  expect(resolvePhotoUrls(['https://r2/a.jpg', 'https://r2/b.jpg'], 'https://fb/x.jpg')).toEqual([
    'https://r2/a.jpg',
    'https://r2/b.jpg',
  ])
  expect(resolvePhotoUrls([], 'https://fb/x.jpg')).toEqual(['https://fb/x.jpg'])
  expect(resolvePhotoUrls(null, 'https://fb/x.jpg')).toEqual(['https://fb/x.jpg'])
  expect(resolvePhotoUrls(null, null)).toEqual([])
})
