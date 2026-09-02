import {
  buildPriceReviewPrompt,
  PRICE_REVIEW_RESPONSE_SCHEMA,
  extractDescriptionPrice,
  descriptionPriceDiverges,
} from './price-review'
import type { PriceReviewCandidate } from './price-review'

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

test('extractDescriptionPrice reads a keyword/currency-prefixed or k-abbreviated amount', () => {
  expect(
    extractDescriptionPrice('iphone 16 slightly use 128gb 2cycle count 100 battery under warranty march 2027\nprice 39k'),
  ).toBe(39000)
  expect(extractDescriptionPrice('₱39,000 fixed')).toBe(39000)
  expect(extractDescriptionPrice('asking 39000, slightly nego')).toBe(39000)
  expect(extractDescriptionPrice('Price: 39,500 slightly negotiable')).toBe(39500)
  expect(extractDescriptionPrice('FOR SALE 45K rush')).toBe(45000)
  expect(extractDescriptionPrice('get it for 1.2k na lang')).toBe(1200)
})

test('extractDescriptionPrice ignores unrelated numbers and implausible values', () => {
  expect(extractDescriptionPrice('iphone 16 128gb, 100% battery, model 2023')).toBeNull()
  expect(extractDescriptionPrice('12500')).toBeNull() // bare integer, no prefix, no "k"
  expect(extractDescriptionPrice('dm for price')).toBeNull()
  expect(extractDescriptionPrice(null)).toBeNull()
  expect(extractDescriptionPrice('price 100')).toBeNull() // below the ₱500 floor
})

test('descriptionPriceDiverges flags a recorded price 5x+ off the description price', () => {
  // ₱39,000 keyed as ₱3,900 - a single dropped digit, ~10x
  expect(descriptionPriceDiverges('price 39k', 3900)).toBe(true)
  // recorded matches the description closely enough
  expect(descriptionPriceDiverges('price 39k', 38000)).toBe(false)
  // nothing price-shaped in the text
  expect(descriptionPriceDiverges('iphone 16 128gb', 3900)).toBe(false)
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
