import { buildPriceLookupPrompt, parsePriceRangeResponse } from './pricing'

test('buildPriceLookupPrompt lists each product by id and label, with variant tier when present', () => {
  const prompt = buildPriceLookupPrompt([
    { id: 1, base_model: 'Sony WH-1000XM4', variant_tier: null },
    { id: 2, base_model: 'RTX 3060', variant_tier: 'OC' },
  ])

  expect(prompt).toContain('[id: 1] Sony WH-1000XM4')
  expect(prompt).toContain('[id: 2] RTX 3060 (OC)')
})

test('buildPriceLookupPrompt asks for a fenced json array and instructs found:false over guessing', () => {
  const prompt = buildPriceLookupPrompt([{ id: 1, base_model: 'RTX 3060', variant_tier: null }])

  expect(prompt).toContain('```json')
  expect(prompt).toContain('found')
  expect(prompt).toContain('instead of guessing')
})

test('parsePriceRangeResponse extracts a found product from the fenced json block', () => {
  const text = `Based on my search:

\`\`\`json
[{"id": "1", "found": true, "price_low": 4500, "price_high": 12000, "currency": "PHP"}]
\`\`\`
`
  expect(parsePriceRangeResponse(text)).toEqual([
    { id: '1', found: true, price_low: 4500, price_high: 12000, currency: 'PHP' },
  ])
})

test('parsePriceRangeResponse handles multiple products in one batch, including a not-found one', () => {
  const text = `\`\`\`json
[
  {"id": "1", "found": true, "price_low": 10000, "price_high": 15000, "currency": "PHP"},
  {"id": "2", "found": false}
]
\`\`\``
  expect(parsePriceRangeResponse(text)).toEqual([
    { id: '1', found: true, price_low: 10000, price_high: 15000, currency: 'PHP' },
    { id: '2', found: false, price_low: null, price_high: null, currency: null },
  ])
})

test('parsePriceRangeResponse returns null when there is no fenced json block', () => {
  expect(parsePriceRangeResponse('I could not find enough listings to determine a price range.')).toBeNull()
})

test('parsePriceRangeResponse returns null when the fenced block is not valid json', () => {
  expect(parsePriceRangeResponse('```json\n{not valid json\n```')).toBeNull()
})

test('parsePriceRangeResponse skips an item claiming found:true with a missing/non-numeric price', () => {
  const text = `\`\`\`json
[{"id": "1", "found": true, "price_high": 12000, "currency": "PHP"}]
\`\`\``
  expect(parsePriceRangeResponse(text)).toEqual([])
})
