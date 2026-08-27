import type { DbClient } from '../../storage/client'
import { upsertListing, getCollectedListingIds } from './storage'

function mockDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return undefined
      },
    },
  }
}

test('upsertListing extracts known fields and stores the full raw object as json', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_price: { amount: '15500.00', currency: 'PHP' },
    redacted_description: { text: 'Barely used, comes with case.' },
    attribute_data: [
      { label: 'Used - Good', value: 'used_good', attribute_name: 'Condition' },
      { label: 'Sony', value: 'Sony', attribute_name: 'Brand' },
    ],
    marketplace_listing_category_id: '1792291877663080',
    location: { latitude: 14.33, longitude: 120.94, reverse_geocode: { city: 'Dasmariñas' } },
    primary_listing_photo: { image: { uri: 'https://scontent.example/photo.jpg' } },
    creation_time: 1786660802,
  }

  await upsertListing(db, listing)

  expect(calls).toHaveLength(1)
  const [
    id, title, priceAmount, priceCurrency, description, condition, categoryId, lat, lng, city,
    photoUrl, storedPhotoUrls, listedAt, rawJson,
  ] = calls[0].params

  expect(id).toBe('12345')
  expect(title).toBe('Sony WH-1000XM6')
  expect(priceAmount).toBe(15500)
  expect(priceCurrency).toBe('PHP')
  expect(description).toBe('Barely used, comes with case.')
  expect(condition).toBe('Used - Good')
  expect(categoryId).toBe('1792291877663080')
  expect(lat).toBe(14.33)
  expect(lng).toBe(120.94)
  expect(city).toBe('Dasmariñas')
  expect(photoUrl).toBe('https://scontent.example/photo.jpg')
  expect(storedPhotoUrls).toBeNull()
  expect((listedAt as Date).getTime()).toBe(1786660802 * 1000)
  expect(JSON.parse(rawJson as string)).toEqual(listing)
})

test('upsertListing extracts condition from attribute_data, not a top-level field', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'Test',
    attribute_data: [
      { label: 'Brand', value: 'Sony', attribute_name: 'Brand' },
      { label: 'New', value: 'new', attribute_name: 'Condition' },
    ],
  })

  expect(calls[0].params[5]).toBe('New')
})

test('upsertListing sets condition to null when attribute_data has no Condition entry', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'Test',
    attribute_data: [{ label: 'Sony', value: 'Sony', attribute_name: 'Brand' }],
  })

  expect(calls[0].params[5]).toBeNull()
})

test('upsertListing stores re-hosted photo URLs as a json array', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    stored_photo_urls: ['https://images.example.com/listings/12345/0.jpg', 'https://images.example.com/listings/12345/1.jpg'],
  }

  await upsertListing(db, listing)

  const storedPhotoUrls = calls[0].params[11]
  expect(JSON.parse(storedPhotoUrls as string)).toEqual(listing.stored_photo_urls)
})

test('upsertListing fills missing optional fields with null instead of throwing', async () => {
  const { db, calls } = mockDb()
  const listing = { id: '999', marketplace_listing_title: 'Bare Listing' }

  await upsertListing(db, listing)

  const params = calls[0].params
  expect(params[0]).toBe('999')
  expect(params[1]).toBe('Bare Listing')
  expect(params[2]).toBeNull()
  expect(params[3]).toBeNull()
  expect(params[4]).toBeNull()
  expect(params[5]).toBeNull()
  expect(params[6]).toBeNull()
  expect(params[7]).toBeNull()
  expect(params[8]).toBeNull()
  expect(params[9]).toBeNull()
  expect(params[10]).toBeNull()
  expect(params[11]).toBeNull()
})

test('upsertListing falls back to custom_title when marketplace_listing_title is absent', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, { id: '1', custom_title: 'Custom Name' })
  expect(calls[0].params[1]).toBe('Custom Name')
})

test('upsertListing runs the keyword scan and flags negotiable when the description matches', async () => {
  const { db, calls } = mockDb()

  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'RTX 3060',
    listing_price: { amount: '15000', currency: 'PHP' },
    redacted_description: { text: 'Nego pa presyo, message me' },
  })

  expect(calls).toHaveLength(2)
  expect(calls[1].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[1].params).toEqual(['1', 'keyword match: "nego"'])
})

test('upsertListing does not touch listing_price_review when nothing matches', async () => {
  const { db, calls } = mockDb()

  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'RTX 3060',
    listing_price: { amount: '15000', currency: 'PHP' },
    redacted_description: { text: 'Barely used, comes with box.' },
  })

  expect(calls).toHaveLength(1)
})

test('getCollectedListingIds returns every listing id as a Set, for dedup during collection', async () => {
  const db = {
    query: async (sql: string) => {
      expect(sql).toBe('SELECT id FROM listings')
      return { rows: [{ id: '1' }, { id: '2' }] }
    },
  }

  const result = await getCollectedListingIds(db)

  expect(result).toBeInstanceOf(Set)
  expect([...result]).toEqual(['1', '2'])
})
