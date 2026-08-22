import { buildNewPriceQuery, buildNewPriceSystemPrompt, NEW_PRICE_OUTPUT_SCHEMA, parseNewPriceContent } from '../src/new-price'

test('buildNewPriceQuery includes variant tier when present', () => {
  expect(buildNewPriceQuery('Sony WH-1000XM4', 'Silent White')).toBe(
    'Sony WH-1000XM4 (Silent White) brand new retail price Philippines',
  )
})

test('buildNewPriceQuery omits variant tier when absent', () => {
  expect(buildNewPriceQuery('Sony WH-1000XM4', null)).toBe('Sony WH-1000XM4 brand new retail price Philippines')
})

test('buildNewPriceSystemPrompt has the base instructions with no description or siblings', () => {
  const prompt = buildNewPriceSystemPrompt(null, [])
  expect(prompt).toContain('Philippine Peso')
  expect(prompt).not.toContain('Product context:')
  expect(prompt).not.toContain('Other tracked variants')
})

test('buildNewPriceSystemPrompt appends the description as disambiguating context when present', () => {
  const prompt = buildNewPriceSystemPrompt('A flagship noise-cancelling over-ear headphone from Sony.', [])
  expect(prompt).toContain('Product context: A flagship noise-cancelling over-ear headphone from Sony.')
})

test('buildNewPriceSystemPrompt appends sibling variants so the model prices the right one, not a relative', () => {
  const prompt = buildNewPriceSystemPrompt(null, ['Pro', 'Pro Max', 'Mini'])
  expect(prompt).toContain('Other tracked variants of this same base model (price the requested one, not these): Pro, Pro Max, Mini')
})

test('NEW_PRICE_OUTPUT_SCHEMA is locked (Exa structured-output request shape)', () => {
  expect(NEW_PRICE_OUTPUT_SCHEMA).toEqual({
    type: 'object',
    required: ['found'],
    properties: {
      found: { type: 'boolean', description: 'true if a real current PHP new-retail price was found' },
      price_low: { type: 'number', description: 'lowest observed new-retail price in PHP' },
      price_high: { type: 'number', description: 'highest observed new-retail price in PHP' },
    },
  })
})

test('parseNewPriceContent returns a PriceRange when found is true with both prices', () => {
  const result = parseNewPriceContent({ found: true, price_low: 14499, price_high: 19999 })
  expect(result).toEqual({ low: 14499, high: 19999, currency: 'PHP' })
})

test('parseNewPriceContent returns null when found is false', () => {
  expect(parseNewPriceContent({ found: false })).toBeNull()
})

test('parseNewPriceContent returns null when found is true but prices are missing or malformed', () => {
  expect(parseNewPriceContent({ found: true })).toBeNull()
  expect(parseNewPriceContent({ found: true, price_low: 'not a number', price_high: 19999 })).toBeNull()
  expect(parseNewPriceContent(null)).toBeNull()
  expect(parseNewPriceContent('not an object')).toBeNull()
})
