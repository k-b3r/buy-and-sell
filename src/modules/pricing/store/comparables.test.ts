import { expect, test } from 'vitest'
import { getComparableListings, getPeerMedianPrice, getSoldComparablePrice } from './comparables'
import type { QueryClient } from '../../../platform/storage'
import { peerListingSql } from './fragments'

test('getSoldComparablePrice returns the clean median and sample size when at least 3 sold comps exist', async () => {
  const db: QueryClient = {
    query: async () => ({ rows: [{ sample_size: '4', clean_median_price: '15000' }] }),
  }

  const result = await getSoldComparablePrice(db, 42)

  expect(result).toEqual({ medianPrice: 15000, sampleSize: 4 })
})

test('getSoldComparablePrice returns null when fewer than 3 sold comps exist', async () => {
  const db: QueryClient = {
    query: async () => ({ rows: [{ sample_size: '2', clean_median_price: null }] }),
  }

  expect(await getSoldComparablePrice(db, 42)).toBeNull()
})

test('getSoldComparablePrice returns null when there are no sold comps at all', async () => {
  const db: QueryClient = {
    query: async () => ({ rows: [{ sample_size: '0', clean_median_price: null }] }),
  }

  expect(await getSoldComparablePrice(db, 42)).toBeNull()
})

test('getSoldComparablePrice scopes to sold listings only, excludes placeholder prices and price-lookup-excluded products', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [{ sample_size: '0', clean_median_price: null }] }
    },
  }

  await getSoldComparablePrice(db, 42)

  expect(capturedSql).toContain('sold_at IS NOT NULL')
  expect(capturedSql).toContain('NOT p.price_lookup_excluded')
  expect(capturedSql).toContain("'^(\\d+)\\1+$'")
  expect(capturedParams).toEqual([42])
})

test('getPeerMedianPrice returns the clean median and sample size when at least 3 peer listings exist', async () => {
  const db: QueryClient = {
    query: async () => ({ rows: [{ sample_size: '3', clean_median_price: '12000' }] }),
  }

  const result = await getPeerMedianPrice(db, 42)

  expect(result).toEqual({ medianPrice: 12000, sampleSize: 3 })
})

test('getPeerMedianPrice returns null when fewer than 3 peer listings exist', async () => {
  const db: QueryClient = {
    query: async () => ({ rows: [{ sample_size: '2', clean_median_price: null }] }),
  }

  expect(await getPeerMedianPrice(db, 42)).toBeNull()
})

test('getPeerMedianPrice scopes to active and recently sold listings, excludes placeholder prices and price-lookup-excluded products', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [{ sample_size: '0', clean_median_price: null }] }
    },
  }

  await getPeerMedianPrice(db, 42)

  expect(capturedSql).toContain(peerListingSql('pl'))
  expect(capturedSql).toContain('NOT p.price_lookup_excluded')
  expect(capturedSql).toContain("'^(\\d+)\\1+$'")
  expect(capturedParams).toEqual([42])
})

test('getComparableListings maps rows, resolving photo urls and casting numeric/date columns', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        {
          listing_id: 'l2',
          title: 'iPhone 12 128GB',
          price_amount: '13500',
          primary_photo_url: 'https://example.com/p.jpg',
          stored_photo_urls: null,
          date: new Date('2026-08-15T00:00:00Z'),
        },
      ],
    }),
  }

  const result = await getComparableListings(db, { productId: 42, excludeListingId: 'l1', sold: true })

  expect(result).toEqual([
    {
      listing_id: 'l2',
      title: 'iPhone 12 128GB',
      price_amount: 13500,
      photo_url: 'https://example.com/p.jpg',
      date: '2026-08-15T00:00:00.000Z',
    },
  ])
})

test('getComparableListings scopes to sold listings, excludes the current listing, placeholder prices, and price-lookup-excluded products', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getComparableListings(db, { productId: 42, excludeListingId: 'l1', sold: true, limit: 3 })

  expect(capturedSql).toContain('pl.sold_at IS NOT NULL')
  expect(capturedSql).toContain('pl.id != $2')
  expect(capturedSql).toContain('NOT p.price_lookup_excluded')
  expect(capturedSql).toContain("'^(\\d+)\\1+$'")
  expect(capturedParams).toEqual([42, 'l1', 3])
})

test('getComparableListings scopes to the peer listings (active and recently sold) when sold is false', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getComparableListings(db, { productId: 42, excludeListingId: 'l1', sold: false })

  expect(capturedSql).toContain(peerListingSql('pl'))
})

test('getComparableListings returns rows only for a product whose comparables reach the minimum sample', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getComparableListings(db, { productId: 42, excludeListingId: 'l1', sold: true })

  expect(capturedSql).toContain('m.raw_median_price IS NOT NULL')
  expect(capturedSql).toContain('count(*) >= 3')
})
