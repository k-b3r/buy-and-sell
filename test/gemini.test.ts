import type { GeminiClient } from '../src/gemini'

// createGeminiClient itself wraps the real SDK and is not unit tested here —
// same precedent as createDbPool/createR2ImageStore/launchBrowser elsewhere
// in this repo. This test just locks down the GeminiClient shape that the
// rest of the pipeline is built against.
function fakeGeminiClient(response: unknown): GeminiClient {
  return {
    generateJson: async () => response,
  }
}

test('a GeminiClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client = fakeGeminiClient([{ id: '1', base_model: 'RTX 3060' }])
  const result = await client.generateJson('some prompt', { type: 'array' })
  expect(result).toEqual([{ id: '1', base_model: 'RTX 3060' }])
})
