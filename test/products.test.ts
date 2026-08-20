import { normalizeBaseModel, buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA } from '../src/products'
import { buildVariantSchema, buildVariantPrompt } from '../src/products'

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

test('EXTRACTION_RESPONSE_SCHEMA is an array schema requiring id and base_model per item', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('array')
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toEqual(['id', 'base_model'])
})

test('buildVariantSchema constrains variant_tier to exactly the given enum values', () => {
  const schema = buildVariantSchema(['Reference/Founders Edition', 'Custom AIB/OC', 'Unknown'])
  expect(schema.items.properties.variant_tier.enum).toEqual([
    'Reference/Founders Edition',
    'Custom AIB/OC',
    'Unknown',
  ])
  expect(schema.items.required).toEqual(['id', 'variant_tier'])
})

test('buildVariantPrompt names the base model, lists the enum values, and lists each listing', () => {
  const prompt = buildVariantPrompt('RTX 3060', ['Reference/Founders Edition', 'Custom AIB/OC'], [
    { id: '1', title: 'RTX 3060 OC Asus', description: 'Factory overclocked' },
  ])

  expect(prompt).toContain('RTX 3060')
  expect(prompt).toContain('"Reference/Founders Edition"')
  expect(prompt).toContain('"Custom AIB/OC"')
  expect(prompt).toContain('[id: 1] title: "RTX 3060 OC Asus"')
})
