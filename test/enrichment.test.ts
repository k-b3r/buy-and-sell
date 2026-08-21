import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from '../src/enrichment'
import type { EnrichmentCandidate } from '../src/enrichment'

test('buildEnrichmentPrompt includes each product id/label, and sibling variants only when present', () => {
  const products: EnrichmentCandidate[] = [
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain(
    '[id: 363] iPhone 12 (Mini) — other tracked variants of this base model: (base, no variant), Pro, Pro Max',
  )
  expect(prompt).toContain('[id: 17] RTX 2060')
  expect(prompt).not.toContain('RTX 2060 —')
})

test('ENRICHMENT_RESPONSE_SCHEMA requires a results array with all six fields per item', () => {
  expect(ENRICHMENT_RESPONSE_SCHEMA.type).toBe('object')
  expect(ENRICHMENT_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.required).toEqual([
    'id',
    'description',
    'value_drivers',
    'has_trained_price_knowledge',
    'trained_price_low',
    'trained_price_high',
  ])
})
