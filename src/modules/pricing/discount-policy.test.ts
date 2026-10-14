import { expect, test } from 'vitest'
import { DEFAULT_DISCOUNT_POLICY } from './discount-policy'

test('DEFAULT_DISCOUNT_POLICY is the 30% discount, 1000 peso profit and 500 peso price floor the settings table seeds', () => {
  expect(DEFAULT_DISCOUNT_POLICY).toEqual({
    highDiscountThresholdPercent: 30,
    minProfitPesos: 1000,
    minPricePesos: 500,
  })
})
