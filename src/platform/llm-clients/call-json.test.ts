import type { Logger } from '../logger'
import { failureText, callJson } from './call-json'

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

const noDelay = async () => {}

const quota = () => Object.assign(new Error('rate_limit_exceeded'), { status: 429 })

function clientReturning(...responses: unknown[]) {
  let calls = 0
  return {
    calls: () => calls,
    generateJson: async () => {
      const next = responses[Math.min(calls, responses.length - 1)]
      calls += 1
      if (next instanceof Error) throw next
      return next
    },
  }
}

const options = (overrides: Partial<Parameters<typeof callJson>[3]> = {}) => ({
  provider: 'Groq',
  label: 'batch starting at 0',
  maxAttempts: 3,
  retryDelayMs: 1,
  delay: noDelay,
  logger: silentLogger(),
  ...overrides,
})

test('callJson returns the model answer', async () => {
  const client = clientReturning({ results: [] })
  const outcome = await callJson(client, 'prompt', {}, options())
  expect(outcome).toEqual({ ok: true, raw: { results: [] } })
})

test('a quota error stops at once, without retrying, and reports quota', async () => {
  const client = clientReturning(quota())
  const outcome = await callJson(client, 'prompt', {}, options())

  expect(client.calls()).toBe(1)
  expect(outcome).toMatchObject({ ok: false, reason: 'quota', attempts: 1 })
})

test('a transient failure is retried, then reported as exhausted with the attempt count', async () => {
  const client = clientReturning(new Error('json_validate_failed'))
  const outcome = await callJson(client, 'prompt', {}, options({ maxAttempts: 3 }))

  expect(client.calls()).toBe(3)
  expect(outcome).toMatchObject({ ok: false, reason: 'exhausted', attempts: 3 })
})

test('a failure that clears up still returns the answer', async () => {
  const client = clientReturning(new Error('json_validate_failed'), { results: ['ok'] })
  const outcome = await callJson(client, 'prompt', {}, options())
  expect(outcome).toEqual({ ok: true, raw: { results: ['ok'] } })
})

test('failureText names the two stop reasons the callers log', async () => {
  const quotaOutcome = await callJson(clientReturning(quota()), 'p', {}, options())
  const exhausted = await callJson(clientReturning(new Error('boom')), 'p', {}, options({ maxAttempts: 2 }))

  expect(quotaOutcome.ok).toBe(false)
  expect(exhausted.ok).toBe(false)
  if (quotaOutcome.ok || exhausted.ok) return
  expect(failureText(quotaOutcome)).toBe('quota exhausted')
  expect(failureText(exhausted)).toBe('request failed after 2 attempts')
})
