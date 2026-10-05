import { parseExtractionItem } from './extraction'
import type { ExtractionCandidate } from './product-storage'

const listing: ExtractionCandidate = {
  id: 'l1',
  title: 'PS5 for sale',
  description: null,
  condition: null,
  price_amount: null,
}

test('parseExtractionItem canonicalizes a known alias and keys the product by normalized base model and variant', () => {
  const parsed = parseExtractionItem(
    { id: 'l1', base_model: 'PS5', variant: 'Digital', category: 'Other', sub_category: 'Nonsense' },
    [listing],
  )
  expect(parsed).toEqual({
    candidate: listing,
    baseModel: 'PlayStation 5',
    variant: 'Digital',
    category: 'Other',
    subCategory: null,
    productKey: expect.stringMatching(/::.+$/),
  })
})

test('parseExtractionItem gives the same product key to an alias and its canonical form', () => {
  const alias = parseExtractionItem({ id: 'l1', base_model: 'PS5' }, [listing])
  const canonical = parseExtractionItem({ id: 'l1', base_model: 'PlayStation 5' }, [listing])
  expect(alias?.productKey).toBe(canonical?.productKey)
})

test('parseExtractionItem treats a blank variant as no variant', () => {
  expect(parseExtractionItem({ id: 'l1', base_model: 'RTX 3060', variant: '  ' }, [listing])).toMatchObject({
    variant: null,
    productKey: expect.stringMatching(/::$/),
  })
})

test('parseExtractionItem skips an item without a string id or base_model, or matching no listing in the batch', () => {
  expect(parseExtractionItem({ id: 1, base_model: 'RTX 3060' }, [listing])).toBeNull()
  expect(parseExtractionItem({ id: 'l1' }, [listing])).toBeNull()
  expect(parseExtractionItem({ id: 'other', base_model: 'RTX 3060' }, [listing])).toBeNull()
})
