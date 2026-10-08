import { buildTriagePrompt, parseTriageItem, runPriceTriage } from './price-triage'
import type { TriageCandidate } from './price-triage'

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

test('runPriceTriage saves each parsed verdict and skips malformed items', async () => {
  const saved: unknown[] = []
  const logs: string[] = []
  await runPriceTriage(
    {
      llm: { generateJson: async () => ({ results: [item(), item({ product_id: 8, verdict: 'bogus' })] }) },
      saveRows: async (rows) => {
        saved.push(...rows)
      },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERROR ${m}`) },
      delay: async () => {},
    },
    [candidate(), candidate({ id: 8 })],
  )

  expect(saved).toHaveLength(1)
  expect(logs.some((l) => l.startsWith('WARN') && l.includes('8'))).toBe(true)
})

test('runPriceTriage stops the run cleanly when the gateway is rate limited', async () => {
  const logs: string[] = []
  let calls = 0
  await runPriceTriage(
    {
      llm: {
        generateJson: async () => {
          calls++
          throw Object.assign(new Error('All models rate-limited'), { status: 429 })
        },
      },
      saveRows: async () => {},
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) },
      delay: async () => {},
    },
    [candidate(), candidate({ id: 8 })],
    { batchSize: 1 },
  )

  expect(calls).toBe(1)
  expect(logs.some((l) => l.startsWith('ERROR') && l.includes('stopping'))).toBe(true)
})
