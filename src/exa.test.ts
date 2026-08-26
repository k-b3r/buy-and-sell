import type { ExaClient } from './exa'

// createExaClient itself wraps the real fetch call to api.exa.ai and is not
// unit tested here — same precedent as createGroqClient/createGeminiClient
// elsewhere in this repo. This test just locks down the ExaClient shape the
// rest of the pipeline is built against.
test('an ExaClient exposes searchStructured(query, systemPrompt, schema) returning the full Exa response', async () => {
  const client: ExaClient = {
    searchStructured: async () => ({
      output: { content: { found: true, price_low: 1, price_high: 2 }, grounding: [] },
      results: [],
    }),
  }
  const result = await client.searchStructured('some query', 'some system prompt', { type: 'object' })
  expect(result).toEqual({
    output: { content: { found: true, price_low: 1, price_high: 2 }, grounding: [] },
    results: [],
  })
})
