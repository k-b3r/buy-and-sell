import {
  normalizeBaseModel,
  normalizeVariantTier,
  buildExtractionPrompt,
  EXTRACTION_RESPONSE_SCHEMA,
  PRODUCT_CATEGORIES,
} from './products'

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

test('EXTRACTION_RESPONSE_SCHEMA is an array schema requiring id, base_model, and category, with variant optional', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('array')
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toEqual(['id', 'base_model', 'category'])
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

test('PRODUCT_CATEGORIES includes Other as a catch-all', () => {
  expect(PRODUCT_CATEGORIES).toContain('Other')
})

test('buildExtractionPrompt lists the fixed categories for the model to choose from', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  for (const category of PRODUCT_CATEGORIES) {
    expect(prompt).toContain(category)
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
