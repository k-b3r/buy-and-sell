import type { DbClient } from '../../platform/storage'
import { getRealEstateListings } from './queries'

function recordingReDb(rows: Record<string, unknown>[] = []): {
  db: DbClient
  calls: { sql: string; params: unknown[] }[]
} {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

const reRow = {
  id: '1',
  title: 'Condo',
  primary_photo_url: null,
  stored_photo_urls: null,
  listed_at: null,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  listed_price: '13',
  listing_type: 'sale',
  property_type: 'condo',
  price_php: '13000000',
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: '35',
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Portico',
  area_text: 'Pasig',
  tags: ['rfo'],
  confidence: 'high',
  price_per_sqm: '371428.5714',
  needs_review: false,
}

test('getRealEstateListings maps rows, coerces numerics and returns price per sqm', async () => {
  const { db } = recordingReDb([reRow])
  const [row] = await getRealEstateListings(db)
  expect(row).toMatchObject({
    id: '1',
    listed_price: 13,
    price_php: 13000000,
    floor_sqm: 35,
    lot_sqm: null,
    tags: ['rfo'],
    price_per_sqm: 371428.5714,
    area_text: 'Pasig',
    confidence: 'high',
    needs_review: false,
  })
})

test('getRealEstateListings shows only active real estate and computes price per sqm from the right area', async () => {
  const { db, calls } = recordingReDb()
  await getRealEstateListings(db)
  const sql = calls[0].sql
  expect(sql).toContain('l.sold_at IS NULL')
  expect(sql).toContain('l.flagged_removed_at IS NULL')
  expect(sql).toContain("d.listing_type = 'sale' AND d.price_basis = 'total'")
  expect(sql).toContain("d.property_type IN ('land', 'house_and_lot')")
})

test('getRealEstateListings binds filters as parameters in order and defaults paging', async () => {
  const { db, calls } = recordingReDb()
  await getRealEstateListings(db, {
    listingType: 'rent',
    propertyType: 'condo',
    area: 'Makati',
    minPrice: 1000,
    maxPrice: 50000,
    minSqm: 30,
    limit: 10,
    offset: 20,
  })
  expect(calls[0].sql).not.toContain('Makati')
  expect(calls[0].params).toEqual(['rent', 'condo', '%Makati%', 1000, 50000, 30, 10, 20])
})

test('getRealEstateListings caps limit and falls back to newest for an unknown sort', async () => {
  const { db, calls } = recordingReDb()
  await getRealEstateListings(db, { limit: 9999, sort: 'drop table' as never })
  expect(calls[0].params.at(-2)).toBe(100)
  expect(calls[0].sql).toContain('COALESCE(x.listed_at, x.first_seen_at) DESC')
})

test('getRealEstateListings excludes listings needing review by default and returns only those for view=review', async () => {
  const main = recordingReDb()
  await getRealEstateListings(main.db)
  expect(main.calls[0].sql).toContain('x.needs_review = false')

  const review = recordingReDb()
  await getRealEstateListings(review.db, { view: 'review' })
  expect(review.calls[0].sql).toContain('x.needs_review = true')
  expect(review.calls[0].sql).toContain(
    "d.price_basis = 'unresolved' OR d.confidence = 'low' OR d.listing_type IS NULL",
  )
})

test('getRealEstateListings keeps room shares out of the main list unless asked for', async () => {
  const main = recordingReDb()
  await getRealEstateListings(main.db)
  expect(main.calls[0].sql).toContain("NOT x.tags ? 'room_share'")

  const withRooms = recordingReDb()
  await getRealEstateListings(withRooms.db, { includeRoomShares: true })
  expect(withRooms.calls[0].sql).not.toContain("NOT x.tags ? 'room_share'")
})
