import { buildCategoryBackfillPrompt, CATEGORY_BACKFILL_RESPONSE_SCHEMA } from './category-backfill'
import type { CategoryBackfillCandidate } from './category-backfill'
import { PRODUCT_CATEGORIES } from './products'

test('buildCategoryBackfillPrompt includes each product id/label and the fixed category list', () => {
  const products: CategoryBackfillCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini' },
    { id: 17, base_model: 'RTX 2060', variant_tier: null },
  ]

  const prompt = buildCategoryBackfillPrompt(products)

  expect(prompt).toContain('[id: 363] iPhone 12 (Mini)')
  expect(prompt).toContain('[id: 17] RTX 2060')
  expect(prompt).toContain(PRODUCT_CATEGORIES.join(', '))
})

test('CATEGORY_BACKFILL_RESPONSE_SCHEMA requires a results array with id/category per item', () => {
  expect(CATEGORY_BACKFILL_RESPONSE_SCHEMA.type).toBe('object')
  expect(CATEGORY_BACKFILL_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(CATEGORY_BACKFILL_RESPONSE_SCHEMA.properties.results.items.required).toEqual(['id', 'category'])
  expect(CATEGORY_BACKFILL_RESPONSE_SCHEMA.properties.results.items.properties.category.enum).toEqual(
    PRODUCT_CATEGORIES,
  )
})
