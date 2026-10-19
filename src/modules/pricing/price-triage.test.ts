import { applyTriageVerdicts, buildTriagePrompt, parseTriageItem } from './price-triage'
import type { DbClient } from '../../platform/storage'
import type { TriageCandidate } from './types'

const candidate = (overrides: Partial<TriageCandidate> = {}): TriageCandidate => ({
  id: 7,
  base_model: 'Sony WH-1000XM4',
  variant_tier: null,
  category: 'Audio',
  description: 'Wireless noise-cancelling headphones',
  reason: 'retail_not_found',
  listing_count: 12,
  median_ask: 8500,
  sample_titles: ['Sony XM4 barely used', 'WH1000XM4 complete'],
  ...overrides,
})

const item = (overrides: Record<string, unknown> = {}) => ({
  product_id: 7,
  verdict: 'retry',
  is_specific_product: true,
  confidence: 'high',
  price_low_php: 9000,
  price_high_php: 12000,
  reasoning: 'Real model with a known retail price.',
  ...overrides,
})

test('buildTriagePrompt lists every product with its exclusion reason and listing evidence', () => {
  const prompt = buildTriagePrompt([candidate(), candidate({ id: 8, base_model: 'Aircon', reason: 'groq_generic' })])

  expect(prompt).toContain('"id":7')
  expect(prompt).toContain('Sony WH-1000XM4')
  expect(prompt).toContain('Sony XM4 barely used')
  expect(prompt).toContain('"reason":"groq_generic"')
})

test('buildTriagePrompt tells the model a failed Exa search hints at a generic or non-existent product', () => {
  const prompt = buildTriagePrompt([candidate({ reason: 'exa_no_result' })])

  expect(prompt).toMatch(/exa_no_result.*too generic or does not exist/s)
})

test('parseTriageItem accepts a well-formed verdict for a product in the batch', () => {
  expect(parseTriageItem(item(), [candidate()])).toEqual({
    kind: 'ok',
    row: {
      productId: 7,
      previousReason: 'retail_not_found',
      verdict: 'retry',
      isSpecificProduct: true,
      confidence: 'high',
      priceLow: 9000,
      priceHigh: 12000,
      reasoning: 'Real model with a known retail price.',
    },
  })
})

test('parseTriageItem drops a price range that is missing a side or upside down', () => {
  const half = parseTriageItem(item({ price_high_php: null }), [candidate()])
  const flipped = parseTriageItem(item({ price_low_php: 5000, price_high_php: 1000 }), [candidate()])

  expect(half.kind === 'ok' && [half.row.priceLow, half.row.priceHigh]).toEqual([null, null])
  expect(flipped.kind === 'ok' && [flipped.row.priceLow, flipped.row.priceHigh]).toEqual([null, null])
})

test('parseTriageItem rejects an unknown verdict, a bad confidence, or a product outside the batch', () => {
  expect(parseTriageItem(item({ verdict: 'maybe' }), [candidate()]).kind).toBe('malformed')
  expect(parseTriageItem(item({ confidence: 'sure' }), [candidate()]).kind).toBe('malformed')
  expect(parseTriageItem(item({ product_id: 99 }), [candidate()]).kind).toBe('unknown-candidate')
})

function triageDb(rows: { product_id?: number; previous_reason?: string }[]): { db: DbClient; sqls: string[] } {
  const sqls: string[] = []
  return {
    sqls,
    db: {
      query: async (sql: string) => {
        sqls.push(sql)
        return {
          rows: sql.includes('SELECT DISTINCT previous_reason') || sql.includes('SELECT product_id') ? rows : [],
        }
      },
    },
  }
}

test('applyTriageVerdicts includes each retry product, then marks it applied, and returns the count', async () => {
  const { db, sqls } = triageDb([{ product_id: 5 }])

  const applied = await applyTriageVerdicts(db, 'high')

  expect(applied).toBe(1)
  expect(sqls).toHaveLength(3)
  expect(sqls[0]).toContain('SELECT product_id FROM product_pricing_triage')
  expect(sqls[1]).toContain('INSERT INTO price_exclusion_overrides')
  expect(sqls[2]).toContain('UPDATE product_pricing_triage SET applied_at = now()')
})

test('applyTriageVerdicts rejects a reason no triage row carries before changing anything', async () => {
  const { db, sqls } = triageDb([{ previous_reason: 'too_generic' }])

  await expect(applyTriageVerdicts(db, 'high', ['too_genreic'])).rejects.toThrow(
    'unknown reason(s): too_genreic. Triaged reasons: too_generic',
  )
  expect(sqls).toHaveLength(1)
})
