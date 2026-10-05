import type { DbClient } from '../../platform/storage'
import type { Logger } from '../../platform/logger'
import { recordRealEstatePriceChange } from './price-history'

function historyDb(opts: { realEstate: boolean; hasHistory: boolean; failProbe?: boolean }): {
  db: DbClient
  calls: { sql: string; params: unknown[] }[]
} {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.includes('FROM listings l') && sql.includes("c.name = 'Real Estate'")) {
          if (opts.failProbe) throw new Error('probe boom')
          return { rows: opts.realEstate ? [{ has_history: opts.hasHistory }] : [] }
        }
        return { rows: [] }
      },
    },
  }
}

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  }
}

const priorRow = (amount: string | null) => ({
  old_price_amount: amount,
  old_price_currency: 'PHP',
  old_first_seen_at: '2026-08-20T00:00:00.000Z',
})

const historyInserts = (calls: { sql: string; params: unknown[] }[]) =>
  calls.filter((c) => c.sql.includes('INSERT INTO listing_price_history'))

test('recordRealEstatePriceChange records no price history for a non-real-estate listing whose price changed', async () => {
  const { db, calls } = historyDb({ realEstate: false, hasHistory: false })

  await recordRealEstatePriceChange(db, fakeLogger(), {
    listingId: '12345',
    prior: priorRow('5000000.00'),
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  expect(historyInserts(calls)).toHaveLength(0)
})

test('recordRealEstatePriceChange writes a baseline row then the new price on a real estate first price change', async () => {
  const { db, calls } = historyDb({ realEstate: true, hasHistory: false })

  await recordRealEstatePriceChange(db, fakeLogger(), {
    listingId: '12345',
    prior: priorRow('5000000.00'),
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  const inserts = historyInserts(calls)
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual(['12345', 5000000, 'PHP', '2026-08-20T00:00:00.000Z'])
  expect(inserts[1].params).toEqual(['12345', 4500000, 'PHP'])
})

test('recordRealEstatePriceChange writes only the new price when real estate history already exists', async () => {
  const { db, calls } = historyDb({ realEstate: true, hasHistory: true })

  await recordRealEstatePriceChange(db, fakeLogger(), {
    listingId: '12345',
    prior: priorRow('5000000.00'),
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  const inserts = historyInserts(calls)
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params).toEqual(['12345', 4500000, 'PHP'])
})

test('recordRealEstatePriceChange does not even probe when the price is unchanged', async () => {
  const { db, calls } = historyDb({ realEstate: true, hasHistory: false })

  await recordRealEstatePriceChange(db, fakeLogger(), {
    listingId: '12345',
    prior: priorRow('4500000.00'),
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  expect(calls).toHaveLength(0)
})

test('recordRealEstatePriceChange does nothing when the refresh returned no prior row', async () => {
  const { db, calls } = historyDb({ realEstate: true, hasHistory: false })

  await recordRealEstatePriceChange(db, fakeLogger(), {
    listingId: '12345',
    prior: undefined,
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  expect(calls).toHaveLength(0)
})

test('recordRealEstatePriceChange swallows a failed write and logs a warning', async () => {
  const { db } = historyDb({ realEstate: true, hasHistory: false, failProbe: true })
  const logger = fakeLogger()

  await recordRealEstatePriceChange(db, logger, {
    listingId: '12345',
    prior: priorRow('5000000.00'),
    newPrice: 4500000,
    newCurrency: 'PHP',
  })

  expect(logger.warnings.some((w) => w.includes('price-history'))).toBe(true)
})
