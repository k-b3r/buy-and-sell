import { parseExtractionItem } from './extraction'
import type { ExtractedListing } from './extraction'
import type { ExtractionCandidate } from './product-storage'

const listing: ExtractionCandidate = {
  id: 'l1',
  title: 'PS5 for sale',
  description: null,
  condition: null,
  price_amount: null,
}

function extracted(item: unknown): ExtractedListing {
  const outcome = parseExtractionItem(item, [listing])
  if (outcome.kind !== 'extracted') throw new Error(`expected an extracted item, got ${outcome.kind}`)
  return outcome.listing
}

test('parseExtractionItem canonicalizes a known alias and keys the product by normalized base model and variant', () => {
  const parsed = extracted({
    id: 'l1',
    base_model: 'PS5',
    variant: 'Digital',
    category: 'Other',
    sub_category: 'Nonsense',
  })
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
  const alias = extracted({ id: 'l1', base_model: 'PS5' })
  const canonical = extracted({ id: 'l1', base_model: 'PlayStation 5' })
  expect(alias.productKey).toBe(canonical.productKey)
})

test('parseExtractionItem treats a blank variant as no variant', () => {
  expect(extracted({ id: 'l1', base_model: 'RTX 3060', variant: '  ' })).toMatchObject({
    variant: null,
    productKey: expect.stringMatching(/::$/),
  })
})

test('parseExtractionItem reports an item without a string id or base_model as malformed, with its id when valid', () => {
  expect(parseExtractionItem({ id: 1, base_model: 'RTX 3060' }, [listing])).toEqual({
    kind: 'malformed',
    idHint: '(missing/invalid id)',
  })
  expect(parseExtractionItem({ id: 'l1' }, [listing])).toEqual({ kind: 'malformed', idHint: 'l1' })
})

test('parseExtractionItem reports a null or non-object item as malformed instead of throwing', () => {
  expect(parseExtractionItem(null, [listing])).toEqual({ kind: 'malformed', idHint: '(missing/invalid id)' })
  expect(parseExtractionItem('l1', [listing])).toEqual({ kind: 'malformed', idHint: '(missing/invalid id)' })
})

test('parseExtractionItem reports an id that matches no listing in the batch', () => {
  expect(parseExtractionItem({ id: 'other', base_model: 'RTX 3060' }, [listing])).toEqual({
    kind: 'unknown-candidate',
    id: 'other',
  })
})

test('parseExtractionItem applies a variant alias rule so the alias lands on the canonical product', () => {
  const parsed = extracted({ id: 'l1', base_model: 'Samsung Galaxy A54', variant: '5G' })

  expect(parsed.baseModel).toBe('Samsung Galaxy A54')
  expect(parsed.variant).toBeNull()
  expect(parsed.productKey).toBe(extracted({ id: 'l1', base_model: 'Samsung Galaxy A54' }).productKey)
})

test('parseExtractionItem matches alias rules on normalized text, ignoring case and spacing', () => {
  const parsed = extracted({ id: 'l1', base_model: '  samsung galaxy   a54 ', variant: ' 5g ' })

  expect(parsed.baseModel).toBe('Samsung Galaxy A54')
  expect(parsed.variant).toBeNull()
})

test('parseExtractionItem renames the base model and the variant together when a rule changes both', () => {
  const parsed = extracted({ id: 'l1', base_model: 'PS4 Slim' })

  expect(parsed.baseModel).toBe('PlayStation 4')
  expect(parsed.variant).toBe('Slim')
})

test('parseExtractionItem leaves a name no rule covers untouched', () => {
  const parsed = extracted({ id: 'l1', base_model: 'Sony WH-1000XM4', variant: 'Black' })

  expect(parsed.baseModel).toBe('Sony WH-1000XM4')
  expect(parsed.variant).toBe('Black')
})
