import { parseEnrichmentItem } from './enrichment'
import type { EnrichmentCandidate } from '../types'

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

test('parseEnrichmentItem reports a null item as malformed instead of throwing', () => {
  expect(parseEnrichmentItem(null, [uncategorized])).toEqual({ kind: 'malformed', idHint: '(missing/invalid id)' })
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
