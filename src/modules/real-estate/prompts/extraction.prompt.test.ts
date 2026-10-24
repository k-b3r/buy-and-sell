import { buildRealEstatePrompt } from './extraction.prompt'
import type { RealEstateCandidate } from '../types'

const candidate = (over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id: '1',
  title: 'Condo for sale',
  description: null,
  price_amount: 4500000,
  source_hash: 'h',
  ...over,
})

test('buildRealEstatePrompt lists each listing with its raw price and text amounts', () => {
  const prompt = buildRealEstatePrompt([candidate({ id: '9', title: '1BR Portico 13M', price_amount: 13 })])
  expect(prompt).toContain('"id":"9"')
  expect(prompt).toContain('"listed_price":13')
  expect(prompt).toContain('13000000')
  expect(prompt).toContain('Taguig')
})

test('buildRealEstatePrompt explains pasalo cash-out, condo detection and room shares', () => {
  const prompt = buildRealEstatePrompt([candidate()])
  expect(prompt).toContain('cash out')
  expect(prompt).toContain('room_share')
  expect(prompt).toContain('parking slot')
})
