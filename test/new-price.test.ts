import {
  buildNewPriceQuery,
  buildNewPriceSystemPrompt,
  NEW_PRICE_OUTPUT_SCHEMA,
  parseNewPriceContent,
  extractNewPriceConfidence,
  extractNewPriceMetadata,
} from '../src/new-price'

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

test('buildNewPriceSystemPrompt explicitly instructs against promo/sale pricing', () => {
  const prompt = buildNewPriceSystemPrompt(null, [])
  expect(prompt).toMatch(/standard.*(not|excluding).*promo/i)
})

test('buildNewPriceSystemPrompt tells the model to prefer the most recently published source on conflicting prices', () => {
  const prompt = buildNewPriceSystemPrompt(null, [])
  expect(prompt).toMatch(/most recently published/i)
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
      release_year: { type: 'number', description: 'the year this product was originally released, if known' },
      is_discontinued: { type: 'boolean', description: 'true if the product is discontinued/no longer sold new' },
    },
  })
})

test('parseNewPriceContent returns a PriceRange when found is true with both prices', () => {
  const response = { output: { content: { found: true, price_low: 14499, price_high: 19999 } } }
  expect(parseNewPriceContent(response)).toEqual({ low: 14499, high: 19999, currency: 'PHP' })
})

test('parseNewPriceContent returns null when found is false', () => {
  expect(parseNewPriceContent({ output: { content: { found: false } } })).toBeNull()
})

test('parseNewPriceContent returns null when found is true but prices are missing or malformed', () => {
  expect(parseNewPriceContent({ output: { content: { found: true } } })).toBeNull()
  expect(parseNewPriceContent({ output: { content: { found: true, price_low: 'not a number', price_high: 19999 } } })).toBeNull()
  expect(parseNewPriceContent(null)).toBeNull()
  expect(parseNewPriceContent('not an object')).toBeNull()
  expect(parseNewPriceContent({ output: null })).toBeNull()
  expect(parseNewPriceContent({})).toBeNull()
})

test('extractNewPriceConfidence returns the grounding confidence for the price fields', () => {
  const response = {
    output: {
      content: { found: true, price_low: 100, price_high: 200 },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'high' },
        { field: 'found', confidence: 'high' },
      ],
    },
  }
  expect(extractNewPriceConfidence(response)).toBe('high')
})

test('extractNewPriceConfidence is conservative — low if either price field is low confidence', () => {
  const response = {
    output: {
      content: { found: true, price_low: 100, price_high: 200 },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'low' },
      ],
    },
  }
  expect(extractNewPriceConfidence(response)).toBe('low')
})

test('extractNewPriceConfidence returns null when there is no grounding data', () => {
  expect(extractNewPriceConfidence({ output: { content: {} } })).toBeNull()
  expect(extractNewPriceConfidence(null)).toBeNull()
  expect(extractNewPriceConfidence('not an object')).toBeNull()
})

test('extractNewPriceMetadata pulls release_year and is_discontinued when present', () => {
  const response = { output: { content: { found: true, price_low: 1, price_high: 2, release_year: 2021, is_discontinued: true } } }
  expect(extractNewPriceMetadata(response)).toEqual({ releaseYear: 2021, isDiscontinued: true })
})

test('extractNewPriceMetadata defaults both to null when absent or malformed', () => {
  expect(extractNewPriceMetadata({ output: { content: { found: true, price_low: 1, price_high: 2 } } })).toEqual({
    releaseYear: null,
    isDiscontinued: null,
  })
  expect(extractNewPriceMetadata({ output: { content: { release_year: 'not a number', is_discontinued: 'not a bool' } } })).toEqual({
    releaseYear: null,
    isDiscontinued: null,
  })
  expect(extractNewPriceMetadata(null)).toEqual({ releaseYear: null, isDiscontinued: null })
})
