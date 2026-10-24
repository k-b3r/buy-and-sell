import { buildTriagePrompt } from './price-triage.prompt'
import type { TriageCandidate } from '../types'

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
