import type { DbClient } from '../../platform/storage'
import { insertPriceCheck, getPriceLookupCandidates } from './price-history'

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

test('insertPriceCheck writes a new price_history row for the product, not an upsert', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(
    db,
    42,
    { low: 4500, high: 12000, currency: 'PHP' },
    'Full grounded answer text here.',
    'gemini_grounding',
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^INSERT INTO product_price_history/)
  expect(calls[0].sql).not.toContain('ON CONFLICT')
  expect(calls[0].params).toEqual([
    42,
    4500,
    12000,
    'PHP',
    'Full grounded answer text here.',
    'gemini_grounding',
    null,
    null,
    null,
    null,
  ])
})

test('insertPriceCheck tags a listing-derived price with the listing_prices source and a condition', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(
    db,
    42,
    { low: 14999, high: 15000, currency: 'PHP' },
    'computed from 4 listings',
    'listing_prices',
    'Used - Good',
  )

  expect(calls[0].params).toEqual([
    42,
    14999,
    15000,
    'PHP',
    'computed from 4 listings',
    'listing_prices',
    'Used - Good',
    null,
    null,
    null,
  ])
})

test('insertPriceCheck defaults condition to null when not given (e.g. a blended Gemini-grounded range)', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(db, 42, { low: 14999, high: 15000, currency: 'PHP' }, 'text', 'gemini_grounding')

  expect(calls[0].params[6]).toBeNull()
})

test('insertPriceCheck stores an Exa confidence value when given', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(db, 42, { low: 14999, high: 15000, currency: 'PHP' }, 'raw', 'exa_new_retail', 'New', 'high')

  expect(calls[0].params).toEqual([42, 14999, 15000, 'PHP', 'raw', 'exa_new_retail', 'New', 'high', null, null])
})

test('insertPriceCheck stores release_year and is_discontinued when given', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(
    db,
    42,
    { low: 14999, high: 15000, currency: 'PHP' },
    'raw',
    'exa_new_retail',
    'New',
    'high',
    2021,
    true,
  )

  expect(calls[0].params).toEqual([42, 14999, 15000, 'PHP', 'raw', 'exa_new_retail', 'New', 'high', 2021, true])
})

test('getPriceLookupCandidates skips a product with a price row from ANY source', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getPriceLookupCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_price_history')
  expect(calls[0].sql).not.toContain('source')
  expect(calls[0].sql).toContain('price_lookup_excluded')
  expect(calls[0].sql).toContain("price_lookup_review_status IS DISTINCT FROM 'needs_review'")
  expect(calls[0].sql).toContain('LEFT JOIN product_enrichment')
  expect(calls[0].sql).toContain('sibling_variants')
})
