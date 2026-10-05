import { summarizeError } from './errors'

test('summarizeError collapses whitespace and truncates a long message, leaving a short one untouched', () => {
  expect(summarizeError(new Error('rate limit exceeded'))).toBe('rate limit exceeded')
  expect(summarizeError('plain string error')).toBe('plain string error')
  expect(summarizeError(new Error('line one\n  line two'))).toBe('line one line two')

  const huge = new Error(`400 ${'x'.repeat(500)}`)
  const summarized = summarizeError(huge)
  expect(summarized.length).toBe(201) // 200 chars + ellipsis
  expect(summarized.endsWith('…')).toBe(true)
})
