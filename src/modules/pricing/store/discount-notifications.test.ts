import { expect, test } from 'vitest'
import type { DbClient, QueryClient } from '../../../platform/storage'
import {
  getDiscountNotifications,
  getUnreadDiscountNotificationCount,
  getUnverifiedDiscountCandidates,
  insertDiscountNotifications,
  markAllDiscountNotificationsRead,
  markDiscountNotificationAttempted,
  markDiscountNotificationRead,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
} from './discount-notifications'

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

test('insertDiscountNotifications inserts every decided notification in one statement, ignoring listings that already have one', async () => {
  const { db, calls } = mockDb()

  await insertDiscountNotifications(db, [
    { listingId: '1', productId: 10, discountPercent: 30, referencePrice: 10000 },
    { listingId: '2', productId: 11, discountPercent: 40, referencePrice: 5000 },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO discount_notifications')
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO NOTHING')
  expect(calls[0].params).toEqual(['1', 10, 30, 10000, '2', 11, 40, 5000])
})

test('insertDiscountNotifications runs no query for an empty batch', async () => {
  const { db, calls } = mockDb()

  await insertDiscountNotifications(db, [])

  expect(calls).toHaveLength(0)
})

test('getUnverifiedDiscountCandidates returns pending candidates with listing/product/enrichment context, respecting the retry backoff', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 7,
            listing_id: '123',
            title: 'Sony WH-1000XM5',
            description: 'Used, minor scuff, battery great',
            condition: 'Used - Good',
            price_amount: '6500',
            base_model: 'Sony WH-1000XM5',
            is_specific_product: true,
          },
        ],
      }
    },
  }

  const result = await getUnverifiedDiscountCandidates(db, 3)

  expect(calls[0].sql).toContain('verified_at IS NULL')
  expect(calls[0].sql).toContain('last_verification_attempt_at IS NULL')
  expect(calls[0].sql).toContain("interval '1 hour'")
  expect(calls[0].sql).toContain('LIMIT $1')
  // Excludes a still-unenriched candidate unless its price already fails the
  // floor (that gate needs no enrichment data - see minPricePesos's own
  // comment) - never even fetched until enrich-products actually judges it.
  expect(calls[0].sql).toContain('pe.is_specific_product IS NOT NULL OR l.price_amount < $2')
  expect(calls[0].params).toEqual([3, 500])
  expect(result).toEqual([
    {
      id: 7,
      listing_id: '123',
      title: 'Sony WH-1000XM5',
      description: 'Used, minor scuff, battery great',
      condition: 'Used - Good',
      price_amount: 6500,
      base_model: 'Sony WH-1000XM5',
      is_specific_product: true,
    },
  ])
})

test('markDiscountNotificationVerified sets verified_at and overwrites discount_percent/reference_price with the fresh numbers', async () => {
  const { db, calls } = mockDb()

  await markDiscountNotificationVerified(db, 7, {
    discountPercent: 32,
    referencePrice: 10000,
    source: 'tavily',
    reasoning: 'Fresh secondhand market ~₱10k; minor wear does not explain the gap.',
  })

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('verified_at = now()')
  expect(calls[0].sql).toContain('WHERE id = $1')
  expect(calls[0].params).toEqual([
    7,
    32,
    10000,
    'tavily',
    'Fresh secondhand market ~₱10k; minor wear does not explain the gap.',
  ])
})

test('rejectDiscountNotification deletes the row outright', async () => {
  const { db, calls } = mockDb()

  await rejectDiscountNotification(db, 7)

  expect(calls[0].sql).toMatch(/^DELETE FROM discount_notifications/)
  expect(calls[0].params).toEqual([7])
})

test('markDiscountNotificationAttempted bumps last_verification_attempt_at without touching verified_at', async () => {
  const { db, calls } = mockDb()

  await markDiscountNotificationAttempted(db, 7)

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('last_verification_attempt_at = now()')
  expect(calls[0].sql).not.toContain('verified_at = now()')
  expect(calls[0].params).toEqual([7])
})
