import type { DbClient } from '../../../platform/storage'
import { getEnrichmentCandidates, upsertProductEnrichment } from './enrichment'

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

test('getEnrichmentCandidates returns products without an enrichment row, with sibling variant names', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 363,
            base_model: 'iPhone 12',
            variant_tier: 'Mini',
            category: null,
            sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
          },
          { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'PC Components', sibling_variants: [] },
        ],
      }
    },
  }

  const result = await getEnrichmentCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_enrichment')
  expect(calls[0].sql).toContain('categories')
  expect(result).toEqual([
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      category: null,
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'PC Components', sibling_variants: [] },
  ])
})

test('upsertProductEnrichment inserts with PHP currency derived when a trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    363,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: true,
      trainedPriceLow: 9000,
      trainedPriceHigh: 13000,
      isSpecificProduct: true,
      confidence: 'high',
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO product_enrichment/)
  expect(calls[0].sql).toContain('ON CONFLICT (product_id) DO UPDATE')
  expect(calls[0].params).toEqual([
    363,
    'desc',
    'drivers',
    true,
    9000,
    13000,
    'PHP',
    'openai/gpt-oss-120b',
    true,
    'high',
  ])
})

test('upsertProductEnrichment stores null currency when no trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    17,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: false,
      trainedPriceLow: null,
      trainedPriceHigh: null,
      isSpecificProduct: false,
      confidence: 'low',
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].params).toEqual([17, 'desc', 'drivers', false, null, null, null, 'openai/gpt-oss-120b', false, 'low'])
})
