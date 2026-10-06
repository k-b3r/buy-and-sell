import { expect, test } from 'vitest'
import {
  getComparableListings,
  getDiscountNotifications,
  getPeerMedianPrice,
  getSoldComparablePrice,
  getUnreadDiscountNotificationCount,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
  setManualPrice,
} from './queries'
import type { QueryClient } from '../../platform/storage'
import { peerListingSql } from './clean-median'

test('getDiscountNotifications maps joined rows into DiscountNotification shape, most recent first, capped by limit', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 7,
            listing_id: '123',
            product_id: 1,
            title: 'Sony WH-1000XM6',
            primary_photo_url: 'https://x/0.jpg',
            stored_photo_urls: null,
            discount_percent: '42',
            reference_price: '15000',
            created_at: '2026-08-30T00:00:00.000Z',
            read_at: null,
            verification_reasoning: "Fresh secondhand market ~₱15k vs ₱8.7k ask; minor scuffs don't explain the gap.",
          },
        ],
      }
    },
  }

  const result = await getDiscountNotifications(db, 20)

  expect(calls[0].sql).toContain('dn.verified_at IS NOT NULL')
  expect(calls[0].sql).toContain('dn.verification_reasoning')
  expect(calls[0].sql).toContain('ORDER BY dn.created_at DESC')
  expect(calls[0].sql).toContain('LIMIT $1')
  expect(calls[0].params).toEqual([20])
  expect(result).toEqual([
    {
      id: 7,
      listing_id: '123',
      product_id: 1,
      title: 'Sony WH-1000XM6',
      primary_photo_url: 'https://x/0.jpg',
      discount_percent: 42,
      reference_price: 15000,
      created_at: '2026-08-30T00:00:00.000Z',
      read_at: null,
      verification_reasoning: "Fresh secondhand market ~₱15k vs ₱8.7k ask; minor scuffs don't explain the gap.",
    },
  ])
})

test('getDiscountNotifications prefers stored_photo_urls over primary_photo_url', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        {
          id: 1,
          listing_id: '1',
          product_id: 1,
          title: 'x',
          primary_photo_url: 'https://x/expired.jpg',
          stored_photo_urls: ['https://r2/0.jpg'],
          discount_percent: '30',
          reference_price: '1000',
          created_at: '2026-08-30T00:00:00.000Z',
          read_at: null,
        },
      ],
    }),
  }

  const result = await getDiscountNotifications(db)

  expect(result[0].primary_photo_url).toBe('https://r2/0.jpg')
})

test('getUnreadDiscountNotificationCount returns the unread count as a number', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ count: '3' }] }
    },
  }

  const result = await getUnreadDiscountNotificationCount(db)

  expect(calls[0].sql).toContain('read_at IS NULL')
  expect(calls[0].sql).toContain('verified_at IS NOT NULL')
  expect(result).toBe(3)
})

test('markDiscountNotificationRead sets read_at for the given id, only if not already read', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await markDiscountNotificationRead(db, 7)

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('read_at = now()')
  expect(calls[0].sql).toContain('WHERE id = $1')
  expect(calls[0].params).toEqual([7])
})

test('markAllDiscountNotificationsRead sets read_at on every unread row', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await markAllDiscountNotificationsRead(db)

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('read_at = now()')
  expect(calls[0].sql).toContain('WHERE read_at IS NULL')
  expect(calls[0].params).toEqual([])
})

test('setManualPrice inserts a manual_new_retail row into product_price_history', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await setManualPrice(db, 12, { kind: 'new', priceLow: 1500, priceHigh: 2000 })

  expect(capturedSql).toContain('INSERT INTO product_price_history')
  expect(capturedParams).toEqual([12, 1500, 2000, 'manual_new_retail'])
})

test('setManualPrice inserts a manual_secondhand row into product_price_history', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await setManualPrice(db, 12, { kind: 'secondhand', priceLow: 800, priceHigh: 1200 })

  expect(capturedParams).toEqual([12, 800, 1200, 'manual_secondhand'])
})

test('setManualPrice rejects positional wire args from an older dashboard instead of inserting a null-priced row', async () => {
  let queried = false
  const db: QueryClient = {
    query: async () => {
      queried = true
      return { rows: [] }
    },
  }
  const setManualPriceOverWire = setManualPrice as (db: QueryClient, ...args: unknown[]) => Promise<void>

  await expect(setManualPriceOverWire(db, 12, 'new', 1500, 2000)).rejects.toThrow('setManualPrice')
  await expect(setManualPriceOverWire(db, 12, { kind: 'used', priceLow: 1500, priceHigh: 2000 })).rejects.toThrow(
    'setManualPrice',
  )
  await expect(setManualPriceOverWire(db, 12, { kind: 'new', priceLow: '1500', priceHigh: 2000 })).rejects.toThrow(
    'setManualPrice',
  )
  expect(queried).toBe(false)
})

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
