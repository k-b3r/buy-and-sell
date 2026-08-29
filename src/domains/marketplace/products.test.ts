import {
  normalizeBaseModel,
  normalizeVariantTier,
  buildExtractionPrompt,
  EXTRACTION_RESPONSE_SCHEMA,
  PRODUCT_CATEGORIES,
  buildCategoryBackfillPrompt,
  CATEGORY_BACKFILL_RESPONSE_SCHEMA,
  SUB_CATEGORIES,
  buildSubCategoryBackfillPrompt,
  SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA,
} from './products'
import type { CategoryBackfillCandidate, SubCategoryBackfillCandidate } from './products'

test('normalizeBaseModel trims, lowercases, and collapses internal whitespace', () => {
  expect(normalizeBaseModel('  RTX   3060  ')).toBe('rtx 3060')
  expect(normalizeBaseModel('iPhone 13')).toBe('iphone 13')
})

test('buildExtractionPrompt includes each listing id and title, and truncates long descriptions to 150 chars', () => {
  const longDesc =
    'Barely used, 2020 model, comes with charger and original box, no issues at all whatsoever really, works perfectly fine no scratches or dents anywhere on the case'
  const prompt = buildExtractionPrompt([
    { id: '1', title: 'Rush sale MacBook Air', description: longDesc },
    { id: '2', title: 'For sale rush', description: 'Sony WH-1000XM4 headphones' },
  ])

  expect(prompt).toContain('[id: 1] title: "Rush sale MacBook Air"')
  expect(prompt).toContain('[id: 2] title: "For sale rush"')
  expect(prompt).toContain('Sony WH-1000XM4 headphones')
  expect(prompt).not.toContain('no scratches or dents anywhere on the case')
})

test('EXTRACTION_RESPONSE_SCHEMA is an array schema requiring id, base_model, category, and sub_category, with variant optional', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('array')
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toEqual(['id', 'base_model', 'category', 'sub_category'])
  expect(EXTRACTION_RESPONSE_SCHEMA.items.properties.variant.type).toBe('string')
})

// Fixed, bounded list - freeform categorization would recreate the exact
// base_model fragmentation problem this session spent a lot of effort
// cleaning up, just one level higher (see CONTEXT.md's duplicate-product
// consolidation finding).
test('EXTRACTION_RESPONSE_SCHEMA constrains category to the fixed PRODUCT_CATEGORIES enum', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.items.properties.category.enum).toEqual(PRODUCT_CATEGORIES)
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toContain('category')
})

test('EXTRACTION_RESPONSE_SCHEMA constrains sub_category to the fixed SUB_CATEGORIES enum', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.items.properties.sub_category.enum).toEqual(SUB_CATEGORIES)
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toContain('sub_category')
})

test('PRODUCT_CATEGORIES includes Other as a catch-all', () => {
  expect(PRODUCT_CATEGORIES).toContain('Other')
})

test('buildExtractionPrompt lists the fixed categories for the model to choose from', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  for (const category of PRODUCT_CATEGORIES) {
    expect(prompt).toContain(category)
  }
})

test('buildExtractionPrompt lists the fixed sub-categories for the model to choose from', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  for (const subCategory of SUB_CATEGORIES) {
    expect(prompt).toContain(subCategory)
  }
})

test('buildExtractionPrompt instructs the model to leave variant empty unless clearly signaled', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  expect(prompt.toLowerCase()).toContain('variant')
})

test('normalizeVariantTier trims, lowercases, collapses whitespace, and strips apostrophes', () => {
  expect(normalizeVariantTier('  OC  ')).toBe('oc')
  expect(normalizeVariantTier("Founder's edition")).toBe('founders edition')
  expect(normalizeVariantTier('Founders edition')).toBe('founders edition')
})

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

test('SUB_CATEGORIES has no duplicates and includes Other as the fallback', () => {
  expect(new Set(SUB_CATEGORIES).size).toBe(SUB_CATEGORIES.length)
  expect(SUB_CATEGORIES).toContain('Other')
})

test('buildSubCategoryBackfillPrompt includes each product id/label/current-category and the fixed sub-category list', () => {
  const products: SubCategoryBackfillCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini', category: 'Phones & Tablets' },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'Computers & Laptops' },
  ]

  const prompt = buildSubCategoryBackfillPrompt(products)

  expect(prompt).toContain('[id: 363] iPhone 12 (Mini) — currently filed under: Phones & Tablets')
  expect(prompt).toContain('[id: 17] RTX 2060 — currently filed under: Computers & Laptops')
  expect(prompt).toContain(SUB_CATEGORIES.join(', '))
})

test('SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA requires a results array with id/sub_category per item', () => {
  expect(SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA.type).toBe('object')
  expect(SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA.properties.results.items.required).toEqual(['id', 'sub_category'])
  expect(SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA.properties.results.items.properties.sub_category.enum).toEqual(
    SUB_CATEGORIES,
  )
})
