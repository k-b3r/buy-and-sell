import type { DbClient } from '../../../platform/storage'
import type { TriageRow } from '../price-triage'
import {
  getRetryVerdictProductIds,
  getTriageCandidates,
  getTriagedReasons,
  getTriageSummary,
  markTriageApplied,
  saveTriageRows,
} from './price-triage'

function mockDb(rows: unknown[] = []): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
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

const row: TriageRow = {
  productId: 5,
  previousReason: 'retail_not_found',
  verdict: 'retry',
  isSpecificProduct: true,
  confidence: 'high',
  priceLow: 1000,
  priceHigh: 2000,
  reasoning: 'a real model',
}

test('getTriageCandidates reads excluded products with no triage row, most listings first, and maps the row', async () => {
  const { db, calls } = mockDb([
    {
      id: 5,
      base_model: 'Sony WH-1000XM4',
      variant_tier: null,
      category: 'Audio',
      description: null,
      reason: 'retail_not_found',
      listing_count: 4,
      median_ask: '5500',
      sample_titles: null,
    },
  ])

  const result = await getTriageCandidates(db, 10)

  expect(calls[0].sql).toContain('WHERE p.price_lookup_excluded')
  expect(calls[0].sql).toContain('NOT EXISTS (SELECT 1 FROM product_pricing_triage t WHERE t.product_id = p.id)')
  expect(calls[0].sql).toContain('ORDER BY listing_count DESC, p.id')
  expect(calls[0].sql).toContain('[1:3] AS sample_titles')
  expect(calls[0].params).toEqual([10])
  expect(result).toEqual([
    {
      id: 5,
      base_model: 'Sony WH-1000XM4',
      variant_tier: null,
      category: 'Audio',
      description: null,
      reason: 'retail_not_found',
      listing_count: 4,
      median_ask: 5500,
      sample_titles: [],
    },
  ])
})

test('saveTriageRows upserts one row per product, resetting the applied mark', async () => {
  const { db, calls } = mockDb()

  await saveTriageRows(db, [row, { ...row, productId: 6 }])

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('INSERT INTO product_pricing_triage')
  expect(calls[0].sql).toContain('ON CONFLICT (product_id) DO UPDATE')
  expect(calls[0].sql).toContain('applied_at = NULL')
  expect(calls[0].params).toEqual([5, 'retail_not_found', 'retry', true, 'high', 1000, 2000, 'a real model'])
  expect(calls[1].params[0]).toBe(6)
})

test('getTriagedReasons lists the distinct old exclusion reasons that have triage rows', async () => {
  const { db, calls } = mockDb([{ previous_reason: 'too_generic' }, { previous_reason: 'retail_not_found' }])

  expect(await getTriagedReasons(db)).toEqual(['too_generic', 'retail_not_found'])
  expect(calls[0].sql).toBe('SELECT DISTINCT previous_reason FROM product_pricing_triage')
})

test('getRetryVerdictProductIds selects unapplied retry verdicts at the confidence rank, never overturning manual_review', async () => {
  const { db, calls } = mockDb([{ product_id: 5 }, { product_id: 9 }])

  const ids = await getRetryVerdictProductIds(db, 3, ['too_generic'])

  expect(ids).toEqual([5, 9])
  expect(calls[0].sql).toContain("verdict = 'retry' AND applied_at IS NULL")
  expect(calls[0].sql).toContain("previous_reason <> 'manual_review'")
  expect(calls[0].sql).toContain('($2::text[] IS NULL OR previous_reason = ANY($2))')
  expect(calls[0].params).toEqual([3, ['too_generic']])
})

test('getRetryVerdictProductIds passes null for the reasons filter when none is given', async () => {
  const { db, calls } = mockDb()

  await getRetryVerdictProductIds(db, 2)

  expect(calls[0].params).toEqual([2, null])
})

test('markTriageApplied stamps applied_at for the product', async () => {
  const { db, calls } = mockDb()

  await markTriageApplied(db, 5)

  expect(calls[0].sql).toBe('UPDATE product_pricing_triage SET applied_at = now() WHERE product_id = $1')
  expect(calls[0].params).toEqual([5])
})

test('getTriageSummary counts unapplied verdicts per old reason, verdict and confidence', async () => {
  const summary = [{ previous_reason: 'retail_not_found', verdict: 'retry', confidence: 'high', count: 2 }]
  const { db, calls } = mockDb(summary)

  expect(await getTriageSummary(db)).toEqual(summary)
  expect(calls[0].sql).toContain('WHERE applied_at IS NULL')
  expect(calls[0].sql).toContain('GROUP BY 1, 2, 3 ORDER BY 1, 2, 3')
})
