import { createGroqPool } from './groq-sdk'

// createGroqPool composes createFallbackGroqClient/createRoundRobinGroqClient
// (covered in groq.test.ts) around the SDK-backed client, which isn't
// network-tested here - this just locks down the shape it returns.
test('createGroqPool returns a GroqClient built from the given keys', () => {
  const pool = createGroqPool(['fake-groq-key-0', 'fake-groq-key-1'])
  expect(typeof pool.generateJson).toBe('function')
})
