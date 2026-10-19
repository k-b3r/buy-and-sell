import { decideDiscount, isCheckablePrice, pickReferencePrice } from './discount-decision'
import { DEFAULT_DISCOUNT_POLICY } from './discount-policy'

const listing = { id: '1', productId: 10, condition: 'Used - Good', priceAmount: 7000 }
const range = (low: number, high: number) => ({ low, high, currency: 'PHP' })

test('isCheckablePrice rejects a missing, junk or below-floor price', () => {
  expect(isCheckablePrice(null, DEFAULT_DISCOUNT_POLICY)).toBe(false)
  expect(isCheckablePrice(0, DEFAULT_DISCOUNT_POLICY)).toBe(false)
  expect(isCheckablePrice(DEFAULT_DISCOUNT_POLICY.minPricePesos - 1, DEFAULT_DISCOUNT_POLICY)).toBe(false)
  expect(isCheckablePrice(7000, DEFAULT_DISCOUNT_POLICY)).toBe(true)
})

test('pickReferencePrice uses retail for New, secondhand for used, and asks for the peer median otherwise', () => {
  const pricing = { retail: range(10000, 12000), secondhand: range(8000, 9000) }

  expect(pickReferencePrice('New', pricing)).toBe(10000)
  expect(pickReferencePrice('Used - like new', pricing)).toBe(8000)
  expect(pickReferencePrice('Used - Good', { retail: pricing.retail, secondhand: null })).toBe('peer')
  expect(pickReferencePrice('New', { retail: null, secondhand: pricing.secondhand })).toBeNull()
})

test('decideDiscount returns the notification when the discount and profit bars clear', () => {
  expect(decideDiscount(listing, 7000, 10000, DEFAULT_DISCOUNT_POLICY)).toEqual({
    listingId: '1',
    productId: 10,
    discountPercent: 30,
    referencePrice: 10000,
  })
})

test('decideDiscount returns null for no reference, a thin discount or a magnitude outlier', () => {
  expect(decideDiscount(listing, 7000, null, DEFAULT_DISCOUNT_POLICY)).toBeNull()
  expect(decideDiscount(listing, 7000, 0, DEFAULT_DISCOUNT_POLICY)).toBeNull()
  expect(decideDiscount(listing, 9000, 10000, DEFAULT_DISCOUNT_POLICY)).toBeNull()
  expect(decideDiscount(listing, 100, 1000000, DEFAULT_DISCOUNT_POLICY)).toBeNull()
})
