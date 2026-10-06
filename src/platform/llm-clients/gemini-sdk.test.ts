import { createGeminiClient } from './gemini-sdk'

// The SDK-backed client isn't network-tested here (same precedent as
// createGroqPool); this locks down that it builds a full GeminiClient
// without touching the network.
test('createGeminiClient returns a GeminiClient without calling the API', () => {
  const client = createGeminiClient('fake-gemini-key')
  expect(typeof client.generateJson).toBe('function')
  expect(typeof client.generateGroundedText).toBe('function')
})
