import { buildExaQuery, buildExaSystemPrompt, buildGeminiPrompt, buildTavilyQuery } from './price-lookup.prompt'
import type { PriceLookupCandidate } from '../types'

const candidate: PriceLookupCandidate = {
  id: 1,
  base_model: 'iPhone 13',
  variant_tier: 'Pro Max',
  description: null,
  sibling_variants: [],
}

test('buildGeminiPrompt includes the product label and variant', () => {
  const prompt = buildGeminiPrompt('secondhand', candidate)
  expect(prompt).toContain('iPhone 13 (Pro Max)')
  expect(prompt).toContain('```json')
})

test('buildGeminiPrompt includes description and sibling variants when present', () => {
  const withContext: PriceLookupCandidate = {
    ...candidate,
    description: 'A 2021 flagship phone',
    sibling_variants: ['Pro', '(base, no variant)'],
  }
  const prompt = buildGeminiPrompt('secondhand', withContext)
  expect(prompt).toContain('A 2021 flagship phone')
  expect(prompt).toContain('Pro, (base, no variant)')
})

test('buildGeminiPrompt differs in wording between retail and secondhand', () => {
  const retail = buildGeminiPrompt('retail', candidate)
  const secondhand = buildGeminiPrompt('secondhand', candidate)
  expect(retail).toContain('brand-new retail price')
  expect(retail).not.toContain('secondhand')
  expect(secondhand).toContain('secondhand/used market price')
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

test('buildTavilyQuery asks for retail or secondhand pricing depending on kind', () => {
  expect(buildTavilyQuery('retail', candidate)).toContain('brand-new retail price')
  expect(buildTavilyQuery('secondhand', candidate)).toContain('secondhand used market price')
  expect(buildTavilyQuery('retail', candidate)).toContain('iPhone 13 (Pro Max)')
})
