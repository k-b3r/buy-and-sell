import type { DbClient } from '../../../platform/storage'
import { getRealEstatePriceHistoryState, insertPriceHistoryAt, insertPriceHistoryNow } from './price-history'

function recordingDb(rows: unknown[] = []): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

test('getRealEstatePriceHistoryState probes the listing through its Real Estate category and returns whether history exists', async () => {
  const { db, calls } = recordingDb([{ has_history: true }])

  expect(await getRealEstatePriceHistoryState(db, '123')).toBe(true)

  expect(calls[0].sql).toContain('FROM listing_price_history h WHERE h.listing_id = l.id')
  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('WHERE l.id = $1')
  expect(calls[0].params).toEqual(['123'])
})

test('getRealEstatePriceHistoryState returns false for a real estate listing without history', async () => {
  const { db } = recordingDb([{ has_history: false }])

  expect(await getRealEstatePriceHistoryState(db, '123')).toBe(false)
})

test('getRealEstatePriceHistoryState returns null when the listing is not real estate', async () => {
  const { db } = recordingDb([])

  expect(await getRealEstatePriceHistoryState(db, '123')).toBeNull()
})

test('insertPriceHistoryAt inserts a backdated point with the given recorded_at', async () => {
  const { db, calls } = recordingDb()

  await insertPriceHistoryAt(db, {
    listingId: '123',
    price: 5000000,
    currency: 'PHP',
    recordedAt: '2026-08-20T00:00:00.000Z',
  })

  expect(calls[0].sql).toContain('INSERT INTO listing_price_history')
  expect(calls[0].sql).toContain('recorded_at')
  expect(calls[0].params).toEqual(['123', 5000000, 'PHP', '2026-08-20T00:00:00.000Z'])
})

test('insertPriceHistoryNow inserts a point and leaves recorded_at to the column default', async () => {
  const { db, calls } = recordingDb()

  await insertPriceHistoryNow(db, { listingId: '123', price: 4500000, currency: 'PHP' })

  expect(calls[0].sql).toContain('INSERT INTO listing_price_history')
  expect(calls[0].sql).not.toContain('recorded_at')
  expect(calls[0].params).toEqual(['123', 4500000, 'PHP'])
})
