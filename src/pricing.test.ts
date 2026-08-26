import { buildPriceLookupPrompt, parsePriceRangeResponse } from '../src/pricing'

test('buildPriceLookupPrompt names the product and asks for a parseable trailing line', () => {
  const prompt = buildPriceLookupPrompt('Sony WH-1000XM4', null)
  expect(prompt).toContain('Sony WH-1000XM4')
  expect(prompt).toContain('PRICE_RANGE: <low>-<high> PHP')
})

test('buildPriceLookupPrompt includes the variant tier when present', () => {
  const prompt = buildPriceLookupPrompt('RTX 3060', 'OC')
  expect(prompt).toContain('RTX 3060')
  expect(prompt).toContain('OC')
})

test('parsePriceRangeResponse extracts low/high/currency from the trailing line', () => {
  const text = `Prices vary a lot based on condition and accessories included.

PRICE_RANGE: 4500-12000 PHP`
  expect(parsePriceRangeResponse(text)).toEqual({ low: 4500, high: 12000, currency: 'PHP' })
})

test('parsePriceRangeResponse handles comma-separated thousands', () => {
  const text = 'PRICE_RANGE: 4,500-12,000 PHP'
  expect(parsePriceRangeResponse(text)).toEqual({ low: 4500, high: 12000, currency: 'PHP' })
})

test('parsePriceRangeResponse returns null when no matching line is present', () => {
  expect(parsePriceRangeResponse('I could not find enough listings to determine a price range.')).toBeNull()
})
