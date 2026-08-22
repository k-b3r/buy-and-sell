import { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from '../src/price-review'
import type { PriceReviewCandidate } from '../src/price-review'

test('buildPriceReviewPrompt includes each listing id, recorded price, title, and description', () => {
  const listings: PriceReviewCandidate[] = [
    {
      id: '123',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      description: 'FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED.',
      price_amount: 999999999,
    },
  ]

  const prompt = buildPriceReviewPrompt(listings)

  expect(prompt).toContain('[id: 123]')
  expect(prompt).toContain('recorded_price: ₱999999999')
  expect(prompt).toContain('title: "RTX 2060 6GB FOR SWAP ONLY"')
  expect(prompt).toContain('desc: "FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED."')
})

test('PRICE_REVIEW_RESPONSE_SCHEMA requires a results array with all five fields per item', () => {
  expect(PRICE_REVIEW_RESPONSE_SCHEMA.type).toBe('object')
  expect(PRICE_REVIEW_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(PRICE_REVIEW_RESPONSE_SCHEMA.properties.results.items.required).toEqual([
    'id',
    'is_negotiable',
    'price_low',
    'price_high',
    'reasoning',
  ])
})
