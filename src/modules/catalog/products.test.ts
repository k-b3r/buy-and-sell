import {
  normalizeBaseModel,
  normalizeVariantTier,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
  isProductCategory,
  isSubCategory,
} from './products'

test('normalizeBaseModel trims, lowercases, and collapses internal whitespace', () => {
  expect(normalizeBaseModel('  RTX   3060  ')).toBe('rtx 3060')
  expect(normalizeBaseModel('iPhone 13')).toBe('iphone 13')
})

test('PRODUCT_CATEGORIES includes Other as a catch-all', () => {
  expect(PRODUCT_CATEGORIES).toContain('Other')
})

test('normalizeVariantTier trims, lowercases, collapses whitespace, and strips apostrophes', () => {
  expect(normalizeVariantTier('  OC  ')).toBe('oc')
  expect(normalizeVariantTier("Founder's edition")).toBe('founders edition')
  expect(normalizeVariantTier('Founders edition')).toBe('founders edition')
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
