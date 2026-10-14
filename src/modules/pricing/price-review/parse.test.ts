import { extractDescriptionPrice, descriptionPriceDiverges } from './parse'

test('extractDescriptionPrice reads a keyword/currency-prefixed or k-abbreviated amount', () => {
  expect(
    extractDescriptionPrice(
      'iphone 16 slightly use 128gb 2cycle count 100 battery under warranty march 2027\nprice 39k',
    ),
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
