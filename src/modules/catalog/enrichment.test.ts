import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA, parseEnrichmentItem } from './enrichment'
import type { EnrichmentCandidate } from './enrichment'
import { PRODUCT_CATEGORIES } from './products'

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

test('ENRICHMENT_RESPONSE_SCHEMA requires a results array with all nine fields per item', () => {
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
    'is_specific_product',
    'confidence',
  ])
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.properties.category.enum).toEqual(PRODUCT_CATEGORIES)
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.properties.confidence.enum).toEqual(['high', 'low'])
})

test('buildEnrichmentPrompt instructs the model on is_specific_product/confidence semantics', () => {
  const products: EnrichmentCandidate[] = [
    { id: 1, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [], category: null },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain('is_specific_product')
  expect(prompt).toContain('confidence')
})

const uncategorized: EnrichmentCandidate = {
  id: 7,
  base_model: 'RTX 3060',
  variant_tier: null,
  sibling_variants: [],
  category: null,
}

const validItem = {
  id: '7',
  description: 'A GPU.',
  value_drivers: 'VRAM.',
  has_trained_price_knowledge: true,
  trained_price_low: 9000,
  trained_price_high: 12000,
  category: 'Other',
  is_specific_product: true,
  confidence: 'high',
}

test('parseEnrichmentItem maps a well-formed item to enrichment data and assigns its category to an uncategorized product', () => {
  expect(parseEnrichmentItem(validItem, [uncategorized])).toEqual({
    kind: 'enriched',
    candidate: uncategorized,
    data: {
      description: 'A GPU.',
      valueDrivers: 'VRAM.',
      hasTrainedPriceKnowledge: true,
      trainedPriceLow: 9000,
      trainedPriceHigh: 12000,
      isSpecificProduct: true,
      confidence: 'high',
    },
    category: { kind: 'assign', category: 'Other' },
  })
})

test('parseEnrichmentItem stores non-numeric trained prices as null', () => {
  const outcome = parseEnrichmentItem({ ...validItem, trained_price_low: 'n/a', trained_price_high: null }, [
    uncategorized,
  ])
  expect(outcome.kind === 'enriched' && [outcome.data.trainedPriceLow, outcome.data.trainedPriceHigh]).toEqual([
    null,
    null,
  ])
})

test('parseEnrichmentItem reports a malformed item with its id when the id itself is valid', () => {
  expect(parseEnrichmentItem({ ...validItem, confidence: 'medium' }, [uncategorized])).toEqual({
    kind: 'malformed',
    idHint: '7',
  })
  expect(parseEnrichmentItem({ ...validItem, id: 7 }, [uncategorized])).toEqual({
    kind: 'malformed',
    idHint: '(missing/invalid id)',
  })
})

test('parseEnrichmentItem reports an id that matches no candidate in the batch', () => {
  expect(parseEnrichmentItem({ ...validItem, id: '999' }, [uncategorized])).toEqual({
    kind: 'unknown-candidate',
    id: '999',
  })
})

test('parseEnrichmentItem keeps an existing category and flags an invalid one for an uncategorized product', () => {
  const categorized = { ...uncategorized, category: 'Computers' }
  expect(parseEnrichmentItem(validItem, [categorized])).toMatchObject({ category: { kind: 'keep' } })
  expect(parseEnrichmentItem({ ...validItem, category: 'Nonsense' }, [uncategorized])).toMatchObject({
    category: { kind: 'invalid' },
  })
})
