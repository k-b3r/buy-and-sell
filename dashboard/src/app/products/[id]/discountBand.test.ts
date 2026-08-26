import { expect, test } from 'vitest'
import { isInDiscountBand } from './discountBand'

test('isInDiscountBand matches a percent within the band decade', () => {
  expect(isInDiscountBand(15, 10)).toBe(true)
  expect(isInDiscountBand(19, 10)).toBe(true)
  expect(isInDiscountBand(10, 10)).toBe(true)
})

test('isInDiscountBand rejects a percent outside the band decade', () => {
  expect(isInDiscountBand(9, 10)).toBe(false)
  expect(isInDiscountBand(20, 10)).toBe(false)
})

test('isInDiscountBand rejects a null percent', () => {
  expect(isInDiscountBand(null, 10)).toBe(false)
})
