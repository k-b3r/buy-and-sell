import { expect, test } from 'vitest'
import {
  isWideSpread,
  buildGeminiSecondhandPrompt,
  parseGeminiPriceResponse,
  buildExaQuery,
  buildExaSystemPrompt,
  parseExaPriceResponse,
  buildTavilyQuery,
  parseTavilyPriceAnswer,
} from './price-lookup'
import type { PriceLookupCandidate } from './price-lookup'

const candidate: PriceLookupCandidate = {
  id: 1,
  base_model: 'iPhone 13',
  variant_tier: 'Pro Max',
  description: null,
  sibling_variants: [],
}

test('isWideSpread is true when high is more than 4x low', () => {
  expect(isWideSpread({ low: 1000, high: 5000, currency: 'PHP' })).toBe(true)
})

test('isWideSpread is false within 4x range', () => {
  expect(isWideSpread({ low: 1000, high: 3000, currency: 'PHP' })).toBe(false)
})

test('buildGeminiSecondhandPrompt includes the product label and variant', () => {
  const prompt = buildGeminiSecondhandPrompt(candidate)
  expect(prompt).toContain('iPhone 13 (Pro Max)')
  expect(prompt).toContain('```json')
})

test('buildGeminiSecondhandPrompt includes description and sibling variants when present', () => {
  const withContext: PriceLookupCandidate = {
    ...candidate,
    description: 'A 2021 flagship phone',
    sibling_variants: ['Pro', '(base, no variant)'],
  }
  const prompt = buildGeminiSecondhandPrompt(withContext)
  expect(prompt).toContain('A 2021 flagship phone')
  expect(prompt).toContain('Pro, (base, no variant)')
})

test('parseGeminiPriceResponse extracts a price range from a fenced json block', () => {
  const text = 'Here is what I found:\n```json\n{"found": true, "price_low": 20000, "price_high": 25000}\n```\nDone.'
  expect(parseGeminiPriceResponse(text)).toEqual({ low: 20000, high: 25000, currency: 'PHP' })
})

test('parseGeminiPriceResponse returns null when found is false', () => {
  const text = '```json\n{"found": false}\n```'
  expect(parseGeminiPriceResponse(text)).toBeNull()
})

test('parseGeminiPriceResponse returns null when there is no fenced json block', () => {
  expect(parseGeminiPriceResponse('I could not find pricing for this.')).toBeNull()
})

test('parseGeminiPriceResponse returns null for malformed json', () => {
  expect(parseGeminiPriceResponse('```json\n{not valid\n```')).toBeNull()
})

test('parseGeminiPriceResponse returns null when price fields are missing', () => {
  expect(parseGeminiPriceResponse('```json\n{"found": true}\n```')).toBeNull()
})

test('buildExaQuery asks for retail or secondhand pricing depending on kind', () => {
  expect(buildExaQuery('retail', candidate)).toContain('brand-new retail price')
  expect(buildExaQuery('secondhand', candidate)).toContain('secondhand used market price')
  expect(buildExaQuery('retail', candidate)).toContain('iPhone 13 (Pro Max)')
})

test('buildExaSystemPrompt differs in wording between retail and secondhand', () => {
  expect(buildExaSystemPrompt('retail', candidate)).toContain('brand-new retail price')
  expect(buildExaSystemPrompt('retail', candidate)).toContain('official brand sites')
  expect(buildExaSystemPrompt('secondhand', candidate)).toContain('secondhand (used) market price')
  expect(buildExaSystemPrompt('secondhand', candidate)).toContain('Facebook Marketplace')
})

test('buildExaSystemPrompt includes disambiguation context when present', () => {
  const withContext: PriceLookupCandidate = { ...candidate, description: 'Flagship phone', sibling_variants: ['Pro'] }
  const prompt = buildExaSystemPrompt('secondhand', withContext)
  expect(prompt).toContain('Flagship phone')
  expect(prompt).toContain('Pro')
})

test('parseExaPriceResponse extracts a price range from output.content', () => {
  const response = { output: { content: { found: true, price_low: 18000, price_high: 22000 } } }
  expect(parseExaPriceResponse(response)).toEqual({ low: 18000, high: 22000, currency: 'PHP' })
})

test('parseExaPriceResponse returns null when found is false', () => {
  expect(parseExaPriceResponse({ output: { content: { found: false } } })).toBeNull()
})

test('parseExaPriceResponse returns null for a malformed response', () => {
  expect(parseExaPriceResponse(null)).toBeNull()
  expect(parseExaPriceResponse({})).toBeNull()
  expect(parseExaPriceResponse({ output: {} })).toBeNull()
})

test('buildTavilyQuery asks for retail or secondhand pricing depending on kind', () => {
  expect(buildTavilyQuery('retail', candidate)).toContain('brand-new retail price')
  expect(buildTavilyQuery('secondhand', candidate)).toContain('secondhand used market price')
  expect(buildTavilyQuery('retail', candidate)).toContain('iPhone 13 (Pro Max)')
})

test('parseTavilyPriceAnswer extracts a price range from peso-prefixed amounts in free text', () => {
  const text = 'Listings range from ₱20,000 to ₱25,000 depending on condition.'
  expect(parseTavilyPriceAnswer(text)).toEqual({ low: 20000, high: 25000, currency: 'PHP' })
})

test('parseTavilyPriceAnswer also matches PHP-prefixed amounts', () => {
  const text = 'Current price is around PHP 15,000.'
  expect(parseTavilyPriceAnswer(text)).toEqual({ low: 15000, high: 15000, currency: 'PHP' })
})

test('parseTavilyPriceAnswer ignores small numbers that are unlikely to be prices', () => {
  const text = 'Released in 2021, comes in 5 colors.'
  expect(parseTavilyPriceAnswer(text)).toBeNull()
})

test('parseTavilyPriceAnswer returns null for null or empty text', () => {
  expect(parseTavilyPriceAnswer(null)).toBeNull()
  expect(parseTavilyPriceAnswer('')).toBeNull()
})
