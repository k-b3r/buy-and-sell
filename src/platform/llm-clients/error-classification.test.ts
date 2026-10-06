import { QuotaExhaustedError, errorStatus, isCreditsError, isQuotaError } from './error-classification'

const withStatus = (status: unknown) => Object.assign(new Error(`status ${String(status)}`), { status })

test('errorStatus reads a numeric status off an SDK or fetch error and is undefined otherwise', () => {
  expect(errorStatus(withStatus(503))).toBe(503)
  expect(errorStatus(withStatus('503'))).toBeUndefined()
  expect(errorStatus(new Error('plain'))).toBeUndefined()
  expect(errorStatus(null)).toBeUndefined()
  expect(errorStatus('not an object')).toBeUndefined()
})

test('isQuotaError is true for a 429 or an already-classified QuotaExhaustedError, false for anything else', () => {
  expect(isQuotaError(withStatus(429))).toBe(true)
  expect(isQuotaError(new QuotaExhaustedError('Groq quota gone'))).toBe(true)
  expect(isQuotaError(withStatus(402))).toBe(false)
  expect(isQuotaError(withStatus(400))).toBe(false)
  expect(isQuotaError(new Error('plain error'))).toBe(false)
  expect(isQuotaError('not an object')).toBe(false)
})

test('isCreditsError is true only for a 402 credits-exhausted error', () => {
  expect(isCreditsError(withStatus(402))).toBe(true)
  expect(isCreditsError(withStatus(429))).toBe(false)
  expect(isCreditsError(new Error('plain error'))).toBe(false)
})

test('QuotaExhaustedError keeps the original error as its cause', () => {
  const original = withStatus(429)
  const err = new QuotaExhaustedError('quota', { cause: original })
  expect(err).toBeInstanceOf(Error)
  expect(err.cause).toBe(original)
  expect(err.name).toBe('QuotaExhaustedError')
})
