import { expect, test } from 'vitest'
import { toListingDetail } from './listing-detail'

const row = (price: string | null) => ({
  id: '123',
  title: 'x',
  price_amount: price,
  price_currency: 'PHP',
  product_id: 1,
  stored_photo_urls: null,
  primary_photo_url: 'https://cdn/p.jpg',
  is_saved: false,
})

test('toListingDetail hides the price when it is a magnitude outlier against the sibling median', () => {
  const median = { raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }

  const detail = toListingDetail(row('999999999'), median, [], [])

  expect(detail.price_amount).toBeNull()
  expect(detail.discount_percent).toBeNull()
})

test('toListingDetail keeps an in-range price, falls back to the primary photo and passes the evidence lists through', () => {
  const median = { raw_median_price: '10000', sample_size: '5', clean_median_price: '10000' }

  const detail = toListingDetail(row('8000'), median, [], [])

  expect(detail.price_amount).toBe(8000)
  expect(detail.photo_urls).toEqual(['https://cdn/p.jpg'])
})

test('toListingDetail gives no discount when the listing has no sibling median row', () => {
  const detail = toListingDetail(row('8000'), undefined, [], [])

  expect(detail.discount_percent).toBeNull()
  expect(detail.reference_price).toBeNull()
})
