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
  isProductCategory,
  isSubCategory,
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

// Root must be 'object' (a {results: [...]} envelope), not 'array' - Groq
// hard-rejects an array-rooted response_format schema regardless of model
// (confirmed live 2026-09-03). variant is nullable rather than omitted from
// `required`, since strict mode requires every property be listed there.
test('EXTRACTION_RESPONSE_SCHEMA is a {results: [...]} schema requiring id, base_model, category, and sub_category, with variant nullable', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('object')
  expect(EXTRACTION_RESPONSE_SCHEMA.required).toEqual(['results'])
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.required).toEqual(['id', 'base_model', 'variant', 'category', 'sub_category'])
  expect(items.properties.variant.type).toEqual(['string', 'null'])
})

// Fixed, bounded list - freeform categorization would recreate the exact
// base_model fragmentation problem this session spent a lot of effort
// cleaning up, just one level higher (see CONTEXT.md's duplicate-product
// consolidation finding).
test('EXTRACTION_RESPONSE_SCHEMA constrains category to the fixed PRODUCT_CATEGORIES enum', () => {
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.properties.category.enum).toEqual(PRODUCT_CATEGORIES)
  expect(items.required).toContain('category')
})

test('EXTRACTION_RESPONSE_SCHEMA constrains sub_category to the fixed SUB_CATEGORIES enum', () => {
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.properties.sub_category.enum).toEqual(SUB_CATEGORIES)
  expect(items.required).toContain('sub_category')
})

test('PRODUCT_CATEGORIES includes Other as a catch-all', () => {
  expect(PRODUCT_CATEGORIES).toContain('Other')
})

// A 2026-09-02 catalog scan found the model's #1 cause of duplicate products
// was inconsistently leaving a trim/tier suffix in base_model instead of
// moving it to variant (e.g. "iPhone 14 Plus" [] vs "iPhone 14" [Plus] -
// same real product, two rows). Worked examples across the families that
// fragmented most, plus an explicit rule, are the fix - see
// src/utils/merge-duplicate-products/variant-alias-rules.ts for the cleanup
// this was already needed for once.
test('buildExtractionPrompt tells the model to split a known trim/tier suffix out of base_model into variant, with worked examples', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'iPhone 14 Plus', description: '' }])

  expect(prompt).toContain('base_model: "iPhone 14", variant: "Plus"')
  expect(prompt).toContain('base_model: "iPad", variant: "9th Gen"')
  expect(prompt).toContain('base_model: "MacBook Air", variant: "M2"')
  expect(prompt).toContain('base_model: "Samsung Galaxy S23", variant: "Ultra"')
})

// Bare "5G"/"4G" as a variant was the #2 cause - noise on models sold in
// only one radio band (doubles the row for no reason), but load-bearing on
// models genuinely sold in both. Blanket-stripping it would just move the
// fragmentation problem, not fix it.
test('buildExtractionPrompt tells the model to only record a network band as variant when the same model is sold in more than one band', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'Samsung Galaxy A54 5G', description: '' }])

  expect(prompt).toMatch(/5G.*only.*sold in (more than one|both)|only record.*network band.*variant/is)
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

test('isProductCategory accepts only exact names from the fixed category list', () => {
  expect(isProductCategory('Gaming')).toBe(true)
  expect(isProductCategory('gaming')).toBe(false)
  expect(isProductCategory('Consoles')).toBe(false)
  expect(isProductCategory(null)).toBe(false)
  expect(isProductCategory(7)).toBe(false)
})

test('isSubCategory accepts only exact names from the fixed sub-category list', () => {
  expect(isSubCategory('Consoles')).toBe(true)
  expect(isSubCategory('Other')).toBe(true)
  expect(isSubCategory('Gaming')).toBe(false)
  expect(isSubCategory(undefined)).toBe(false)
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
