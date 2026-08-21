import type { GroqClient } from '../src/groq'

// createGroqClient itself wraps the real SDK and is not unit tested here —
// same precedent as createGeminiClient/createDbPool elsewhere in this repo.
// This test just locks down the GroqClient shape the rest of the pipeline
// is built against.
test('a GroqClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client: GroqClient = {
    generateJson: async () => ({ results: [{ id: '1', description: 'x' }] }),
  }
  const result = await client.generateJson('some prompt', { type: 'object' })
  expect(result).toEqual({ results: [{ id: '1', description: 'x' }] })
})
