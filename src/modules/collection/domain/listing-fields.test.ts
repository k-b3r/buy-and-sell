import { extractPhotoIds, parseListingFields, photoIdsEqual } from './listing-fields'

test('parseListingFields reads condition from attribute_data, not a top-level field', () => {
  const fields = parseListingFields({
    id: 7,
    condition: 'top level is ignored',
    attribute_data: [
      { attribute_name: 'Brand', label: 'Acme' },
      { attribute_name: 'Condition', label: 'Used - Like New' },
    ],
  })

  expect(fields.condition).toBe('Used - Like New')
})

test('parseListingFields falls back to custom_title and fills missing optional fields with null', () => {
  const fields = parseListingFields({ id: 7, custom_title: 'Custom' })

  expect(fields).toEqual({
    id: '7',
    title: 'Custom',
    priceAmount: null,
    priceCurrency: null,
    description: null,
    condition: null,
    categoryId: null,
    locationLat: null,
    locationLng: null,
    locationCity: null,
    primaryPhotoUrl: null,
    storedPhotoUrls: null,
    listedAt: null,
  })
})

test('parseListingFields turns creation_time seconds into a Date and the price amount into a number', () => {
  const fields = parseListingFields({
    id: 7,
    creation_time: 1_700_000_000,
    listing_price: { amount: '4500.50', currency: 'PHP' },
  })

  expect(fields.listedAt).toEqual(new Date(1_700_000_000_000))
  expect(fields.priceAmount).toBe(4500.5)
  expect(fields.priceCurrency).toBe('PHP')
})

test('extractPhotoIds keeps only string ids in order and is null when listing_photos is absent', () => {
  expect(extractPhotoIds({ listing_photos: [{ id: 'a' }, { id: 5 }, undefined, { id: 'b' }] })).toEqual(['a', 'b'])
  expect(extractPhotoIds({ listing_photos: [] })).toEqual([])
  expect(extractPhotoIds({})).toBeNull()
})

test('photoIdsEqual compares ids by position, so a reorder counts as a change', () => {
  expect(photoIdsEqual(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(photoIdsEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  expect(photoIdsEqual(['a'], ['a', 'b'])).toBe(false)
})
