import type { DbClient } from '../../platform/storage'
import { insertPriceCheck, getListingPricesByProduct, getPriceLookupCandidates } from './price-history'

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

  await insertPriceCheck(db, {
    productId: 42,
    price: { low: 4500, high: 12000, currency: 'PHP' },
    rawResponse: 'Full grounded answer text here.',
    source: 'gemini_grounding',
  })

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

  await insertPriceCheck(db, {
    productId: 42,
    price: { low: 14999, high: 15000, currency: 'PHP' },
    rawResponse: 'computed from 4 listings',
    source: 'listing_prices',
    condition: 'Used - Good',
  })

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

  await insertPriceCheck(db, {
    productId: 42,
    price: { low: 14999, high: 15000, currency: 'PHP' },
    rawResponse: 'text',
    source: 'gemini_grounding',
  })

  expect(calls[0].params[6]).toBeNull()
})

test('insertPriceCheck stores an Exa confidence value when given', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(db, {
    productId: 42,
    price: { low: 14999, high: 15000, currency: 'PHP' },
    rawResponse: 'raw',
    source: 'exa_new_retail',
    condition: 'New',
    confidence: 'high',
  })

  expect(calls[0].params).toEqual([42, 14999, 15000, 'PHP', 'raw', 'exa_new_retail', 'New', 'high', null, null])
})

test('insertPriceCheck stores release_year and is_discontinued when given', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(db, {
    productId: 42,
    price: { low: 14999, high: 15000, currency: 'PHP' },
    rawResponse: 'raw',
    source: 'exa_new_retail',
    condition: 'New',
    confidence: 'high',
    releaseYear: 2021,
    isDiscontinued: true,
  })

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

test('getListingPricesByProduct groups by product AND condition, excludes unlabeled-condition listings, requires 3+ per group', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'Used - Good', prices: ['14999', '15000'] },
          { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'New', prices: ['18000', '18500'] },
        ],
      }
    },
  }

  const result = await getListingPricesByProduct(db)

  expect(calls[0].sql).toContain('HAVING count(l.id) >= 3')
  expect(calls[0].sql).toContain('l.condition IS NOT NULL')
  expect(calls[0].sql).toContain('p.id, p.base_model, p.variant_tier, l.condition')
  expect(result).toEqual([
    { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'Used - Good', prices: [14999, 15000] },
    { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'New', prices: [18000, 18500] },
  ])
})

test('getListingPricesByProduct skips price-lookup-excluded products and flagged-removed listings, keeping sold ones', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getListingPricesByProduct(db)

  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[0].sql).toContain('l.flagged_removed_at IS NULL')
  expect(calls[0].sql).not.toContain('sold_at')
})
