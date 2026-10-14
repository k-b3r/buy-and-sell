import { expect, test } from 'vitest'
import {
  getDiscountNotifications,
  getUnreadDiscountNotificationCount,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
} from './queries'
import type { QueryClient } from '../../platform/storage'

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
