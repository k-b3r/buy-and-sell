import type { TavilyClient } from './tavily'

// createTavilyClient itself wraps the real fetch call to api.tavily.com and
// is not unit tested here — same precedent as createExaClient/createGroqClient
// elsewhere in this repo. This test just locks down the TavilyClient shape
// the rest of the pipeline is built against.
test('a TavilyClient exposes search(query) returning an answer plus raw results', async () => {
  const client: TavilyClient = {
    search: async () => ({
      answer: 'Typical secondhand price is PHP 9,500-10,500.',
      results: [{ title: 'Carousell listing', content: 'Selling for 10k, barely used' }],
    }),
  }

  const result = await client.search('Sony WH-1000XM5 secondhand price Philippines')

  expect(result).toEqual({
    answer: 'Typical secondhand price is PHP 9,500-10,500.',
    results: [{ title: 'Carousell listing', content: 'Selling for 10k, barely used' }],
  })
})
