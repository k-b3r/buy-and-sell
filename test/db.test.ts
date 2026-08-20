import type { DbClient } from '../src/db'
import { findOrCreateProduct, updateListingProductIds, upsertListing } from '../src/db'

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
    condition: 'Used - Good',
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

test('findOrCreateProduct inserts a new product when none matches, returns its id', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] } // SELECT finds nothing
      return { rows: [{ id: 42 }] } // INSERT ... RETURNING id
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', null)

  expect(id).toBe(42)
  expect(calls[0].sql).toMatch(/^SELECT/)
  expect(calls[0].params).toEqual(['rtx 3060', null])
  expect(calls[1].sql).toMatch(/^INSERT/)
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', null, null])
})

test('findOrCreateProduct reuses an existing product when normalized base_model + variant_tier already match', async () => {
  const db = { query: async () => ({ rows: [{ id: 7 }] }) }

  const id = await findOrCreateProduct(db, '  RTX 3060  ', 'Custom AIB/OC')

  expect(id).toBe(7)
})

test('findOrCreateProduct dedupes variant_tier on a normalized column, keeping the raw text stored', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] } // SELECT finds nothing
      return { rows: [{ id: 55 }] } // INSERT ... RETURNING id
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', "Founder's edition")

  expect(id).toBe(55)
  expect(calls[0].params).toEqual(['rtx 3060', 'founders edition'])
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', "Founder's edition", 'founders edition'])
})

test('findOrCreateProduct treats "Founders edition" and "Founder\'s edition" as the same product', async () => {
  const products: { id: number; normalized: string; variantNormalized: string | null }[] = []
  let nextId = 1
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        const [normalized, variantNormalized] = params as [string, string | null]
        const match = products.find((p) => p.normalized === normalized && p.variantNormalized === variantNormalized)
        return { rows: match ? [{ id: match.id }] : [] }
      }
      const [, normalized, , variantNormalized] = params as [string, string, string, string | null]
      const id = nextId++
      products.push({ id, normalized, variantNormalized })
      return { rows: [{ id }] }
    },
  }

  const ocId = await findOrCreateProduct(db, 'RTX 3060', 'OC')
  const foundersId = await findOrCreateProduct(db, 'RTX 3060', 'Founders edition')
  const founderSApostropheId = await findOrCreateProduct(db, 'RTX 3060', "Founder's edition")

  expect(foundersId).toBe(founderSApostropheId)
  expect(ocId).not.toBe(foundersId)
})

test('updateListingProductIds does nothing (no query) when given an empty array', async () => {
  const { db, calls } = mockDb()

  await updateListingProductIds(db, [])

  expect(calls).toHaveLength(0)
})

test('updateListingProductIds issues a single multi-row UPDATE for all assignments', async () => {
  const { db, calls } = mockDb()

  await updateListingProductIds(db, [
    { id: '1', productId: 10 },
    { id: '2', productId: 20 },
    { id: '3', productId: 10 },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].params).toEqual(['1', 10, '2', 20, '3', 10])
})
