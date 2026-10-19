import { fetchFreshMarketContext } from './market-context'
import type { DiscountVerificationCandidate, VerificationClients } from '../types'

const candidate: DiscountVerificationCandidate = {
  id: 7,
  listing_id: '123',
  title: 'Sony WH-1000XM5',
  description: null,
  condition: 'Used - Good',
  price_amount: 6500,
  base_model: 'Sony WH-1000XM5',
  is_specific_product: true,
}

function fail(): never {
  throw new Error('provider down')
}

function clients(overrides: {
  exa?: () => unknown
  tavily?: () => { answer: string | null; results: { title: string; content: string }[] }
  gemini?: () => string
}): Pick<VerificationClients, 'exa' | 'tavily' | 'gemini'> {
  return {
    exa: { searchStructured: async () => (overrides.exa ?? fail)() } as VerificationClients['exa'],
    tavily: { search: async () => (overrides.tavily ?? fail)() } as VerificationClients['tavily'],
    gemini: {
      generateJson: fail,
      generateGroundedText: async () => (overrides.gemini ?? fail)(),
    } as VerificationClients['gemini'],
  }
}

test('fetchFreshMarketContext returns the Exa summary first', async () => {
  const result = await fetchFreshMarketContext(
    candidate,
    clients({ exa: () => ({ output: { content: { summary: 'Around 10k' } } }) }),
  )

  expect(result).toEqual({ text: 'Around 10k', source: 'exa' })
})

test('fetchFreshMarketContext falls through to Tavily when Exa errors or returns an empty summary', async () => {
  const tavily = () => ({ answer: 'Secondhand ~10k', results: [] })

  expect(await fetchFreshMarketContext(candidate, clients({ tavily }))).toEqual({
    text: 'Secondhand ~10k',
    source: 'tavily',
  })
  expect(
    await fetchFreshMarketContext(
      candidate,
      clients({ exa: () => ({ output: { content: { summary: ' ' } } }), tavily }),
    ),
  ).toEqual({ text: 'Secondhand ~10k', source: 'tavily' })
})

test('fetchFreshMarketContext joins Tavily result contents when it has no answer', async () => {
  const tavily = () => ({
    answer: null,
    results: [
      { title: 't1', content: 'a' },
      { title: 't2', content: 'b' },
    ],
  })

  expect(await fetchFreshMarketContext(candidate, clients({ tavily }))).toEqual({ text: 'a\nb', source: 'tavily' })
})

test('fetchFreshMarketContext falls through to Gemini grounding, then gives up with null', async () => {
  const empty = () => ({ answer: null, results: [] })

  expect(
    await fetchFreshMarketContext(candidate, clients({ tavily: empty, gemini: () => 'About PHP 10,000' })),
  ).toEqual({
    text: 'About PHP 10,000',
    source: 'gemini_grounding',
  })
  expect(await fetchFreshMarketContext(candidate, clients({ tavily: empty, gemini: () => '  ' }))).toBeNull()
  expect(await fetchFreshMarketContext(candidate, clients({}))).toBeNull()
})
