import { buildClaudePriceQuery, buildClaudePriceSystemPrompt, parseClaudePriceResponse, isWideSpread } from './claude-price'

test('buildClaudePriceQuery includes the variant tier when given', () => {
  expect(buildClaudePriceQuery('iPhone 13', 'Pro Max')).toContain('iPhone 13 (Pro Max)')
  expect(buildClaudePriceQuery('iPhone 13', null)).toMatch(/for: iPhone 13$/)
})

test('buildClaudePriceSystemPrompt appends product context and sibling variants when given', () => {
  const prompt = buildClaudePriceSystemPrompt('A noise-cancelling headphone.', ['Pro', 'Pro Max'])
  expect(prompt).toContain('Product context: A noise-cancelling headphone.')
  expect(prompt).toContain('Pro, Pro Max')
})

test('buildClaudePriceSystemPrompt omits the optional sections when not given', () => {
  const prompt = buildClaudePriceSystemPrompt(null, [])
  expect(prompt).not.toContain('Product context:')
  expect(prompt).not.toContain('Other tracked variants')
})

function textResponse(content: unknown): unknown {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(content) }] }
}

test('parseClaudePriceResponse returns both sides when both are found', () => {
  const response = textResponse({
    retail: { found: true, price_low: 14499, price_high: 19999 },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })

  expect(parseClaudePriceResponse(response)).toEqual({
    retail: { low: 14499, high: 19999, currency: 'PHP' },
    secondhand: { low: 8000, high: 11000, currency: 'PHP' },
  })
})

test('parseClaudePriceResponse returns null for a side reported not found', () => {
  const response = textResponse({
    retail: { found: false },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })

  expect(parseClaudePriceResponse(response)).toEqual({
    retail: null,
    secondhand: { low: 8000, high: 11000, currency: 'PHP' },
  })
})

test('parseClaudePriceResponse reads the LAST text block, not an earlier one', () => {
  const response = {
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: 'Let me search for this.' },
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'text', text: JSON.stringify({ retail: { found: true, price_low: 100, price_high: 200 }, secondhand: { found: false } }) },
    ],
  }

  expect(parseClaudePriceResponse(response)).toEqual({ retail: { low: 100, high: 200, currency: 'PHP' }, secondhand: null })
})

test('parseClaudePriceResponse returns nulls for both sides on a refusal, without reading content', () => {
  const response = { stop_reason: 'refusal', content: [] }

  expect(parseClaudePriceResponse(response)).toEqual({ retail: null, secondhand: null })
})

test('parseClaudePriceResponse returns nulls for both sides when there is no parseable text block', () => {
  expect(parseClaudePriceResponse({ stop_reason: 'end_turn', content: [] })).toEqual({ retail: null, secondhand: null })
  expect(parseClaudePriceResponse(null)).toEqual({ retail: null, secondhand: null })
})

test('isWideSpread flags a spread wider than the default ratio', () => {
  expect(isWideSpread({ low: 4895, high: 58140, currency: 'PHP' })).toBe(true)
  expect(isWideSpread({ low: 14499, high: 19999, currency: 'PHP' })).toBe(false)
})
