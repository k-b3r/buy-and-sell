import { runPriceTriage } from './run'
import type { TriageCandidate } from '../../modules/pricing'

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
