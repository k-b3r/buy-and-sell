import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from '../src/enrichment'
import type { EnrichmentCandidate } from '../src/enrichment'
import { PRODUCT_CATEGORIES } from '../src/products'

test('buildEnrichmentPrompt includes each product id/label, and sibling variants only when present', () => {
  const products: EnrichmentCandidate[] = [
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
      category: null,
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [], category: null },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain(
    '[id: 363] iPhone 12 (Mini) — other tracked variants of this base model: (base, no variant), Pro, Pro Max',
  )
  expect(prompt).toContain('[id: 17] RTX 2060')
  expect(prompt).not.toContain('RTX 2060 —')
})

test('buildEnrichmentPrompt instructs the model to omit entirely-unrecognized products rather than fabricate a description', () => {
  const products: EnrichmentCandidate[] = [
    { id: 1, base_model: 'Obscure Local Brand Widget', variant_tier: null, sibling_variants: [], category: null },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain('omit it from the results array entirely')
  expect(prompt).toContain('do not fabricate')
})

test('buildEnrichmentPrompt includes the fixed category list', () => {
  const products: EnrichmentCandidate[] = [
    { id: 1, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [], category: null },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain(PRODUCT_CATEGORIES.join(', '))
})

test('ENRICHMENT_RESPONSE_SCHEMA requires a results array with all seven fields per item', () => {
  expect(ENRICHMENT_RESPONSE_SCHEMA.type).toBe('object')
  expect(ENRICHMENT_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.required).toEqual([
    'id',
    'description',
    'value_drivers',
    'has_trained_price_knowledge',
    'trained_price_low',
    'trained_price_high',
    'category',
  ])
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.properties.category.enum).toEqual(PRODUCT_CATEGORIES)
})
