import type { DbClient } from '../../platform/storage'
import { getEnrichmentCandidates, upsertProductEnrichment, applyEligibilityFromEnrichment } from './storage'

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
  expect(calls[0].params).toEqual([363, 'desc', 'drivers', true, 9000, 13000, 'PHP', 'openai/gpt-oss-120b', true, 'high'])
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

test('applyEligibilityFromEnrichment auto-excludes high-confidence non-specific products, then flags low-confidence ones for review', async () => {
  const { db, calls } = mockDb()

  await applyEligibilityFromEnrichment(db)

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('UPDATE products p SET price_lookup_excluded = true')
  expect(calls[0].sql).toContain("price_lookup_excluded_reason = 'groq_generic'")
  expect(calls[0].sql).toContain("e.confidence = 'high'")
  expect(calls[0].sql).toContain('e.is_specific_product = false')
  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[1].sql).toContain("UPDATE products p SET price_lookup_review_status = 'needs_review'")
  expect(calls[1].sql).toContain("e.confidence = 'low'")
  expect(calls[1].sql).toContain('NOT p.price_lookup_excluded')
})
