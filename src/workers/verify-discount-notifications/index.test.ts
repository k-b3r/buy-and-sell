import { existsSync, rmSync } from 'node:fs'
import { runVerifyDiscountNotifications } from './index'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { VerificationClients } from '../../domains/marketplace/discount-verification'
import type { DiscountVerificationCandidate } from '../../domains/marketplace/storage/listings'

const LOG_PATH = 'data/tmp-verify-discount-notifications.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function notImplemented(): never {
  throw new Error('not implemented in this fake')
}

function fakeClients(
  overrides: Partial<{ tavilyAnswer: string | null; openrouterResponse: unknown }>,
): VerificationClients {
  const tavilyAnswer = 'tavilyAnswer' in overrides ? overrides.tavilyAnswer! : 'Fresh market ~₱10,000'
  return {
    tavily: { search: async () => ({ answer: tavilyAnswer, results: [] }) },
    exa: { searchStructured: notImplemented },
    gemini: { generateJson: notImplemented, generateGroundedText: notImplemented },
    openrouter: {
      generateJson: async () =>
        overrides.openrouterResponse ?? {
          still_discounted: true,
          fresh_price_low: 9500,
          fresh_price_high: 10500,
          condition_explains_low_price: false,
          meets_profit_bar: true,
          reasoning: 'Genuine deal.',
        },
    },
  }
}

function fakeDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    },
  }
}

function candidate(overrides: Partial<DiscountVerificationCandidate> = {}): DiscountVerificationCandidate {
  return {
    id: 7,
    listing_id: '123',
    title: 'Sony WH-1000XM5',
    description: 'Used, minor scuff, battery great',
    condition: 'Used - Good',
    price_amount: 6500,
    base_model: 'Sony WH-1000XM5',
    is_specific_product: true,
    ...overrides,
  }
}

test('a verified candidate writes the fresh numbers via markDiscountNotificationVerified', async () => {
  const clients = fakeClients({})
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runVerifyDiscountNotifications(clients, db, logger, [candidate()])

  const updateCall = calls.find((c) => c.sql.includes('verified_at = now()'))
  expect(updateCall).toBeDefined()
  expect(updateCall!.params).toEqual([7, 32, 9500, 'tavily', 'Genuine deal.'])
})

test('a rejected candidate is deleted', async () => {
  const clients = fakeClients({
    openrouterResponse: {
      still_discounted: false,
      fresh_price_low: 9500,
      fresh_price_high: 10500,
      condition_explains_low_price: false,
      meets_profit_bar: true,
      reasoning: 'Not actually discounted.',
    },
  })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runVerifyDiscountNotifications(clients, db, logger, [candidate()])

  const deleteCall = calls.find((c) => c.sql.startsWith('DELETE FROM discount_notifications'))
  expect(deleteCall).toBeDefined()
  expect(deleteCall!.params).toEqual([7])
})

test('a pending candidate (no fresh data) bumps last_verification_attempt_at, does not verify or delete', async () => {
  const clients = fakeClients({ tavilyAnswer: null })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runVerifyDiscountNotifications(clients, db, logger, [candidate()])

  const attemptCall = calls.find((c) => c.sql.includes('last_verification_attempt_at = now()'))
  expect(attemptCall).toBeDefined()
  expect(attemptCall!.params).toEqual([7])
  expect(calls.some((c) => c.sql.includes('verified_at = now()'))).toBe(false)
  expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false)
})

test('free rejections/pending are processed for the whole batch even when the paid budget is 0', async () => {
  const clients: VerificationClients = {
    tavily: { search: notImplemented },
    exa: { searchStructured: notImplemented },
    gemini: { generateJson: notImplemented, generateGroundedText: notImplemented },
    openrouter: { generateJson: notImplemented },
  }
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runVerifyDiscountNotifications(
    clients,
    db,
    logger,
    [
      candidate({ id: 1, listing_id: 'a', price_amount: 100 }), // free reject (price floor)
      candidate({ id: 2, listing_id: 'b', is_specific_product: false }), // free reject (non-specific)
      candidate({ id: 3, listing_id: 'c', is_specific_product: null }), // free pending (enrichment)
    ],
    0, // no paid budget at all this lap
  )

  // None of these ever touch a client - proven by notImplemented() never throwing.
  const deleteCalls = calls.filter((c) => c.sql.startsWith('DELETE FROM discount_notifications'))
  expect(deleteCalls.map((c) => c.params)).toEqual([[1], [2]])
  const attemptCalls = calls.filter((c) => c.sql.includes('last_verification_attempt_at = now()'))
  expect(attemptCalls.map((c) => c.params)).toEqual([[3]])
})

test('a paid-eligible candidate beyond the budget is left completely untouched, retried unpenalized next lap', async () => {
  const clients = fakeClients({})
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runVerifyDiscountNotifications(
    clients,
    db,
    logger,
    [candidate({ id: 1, listing_id: 'a' }), candidate({ id: 2, listing_id: 'b' })],
    1, // only 1 paid call allowed this lap
  )

  // Candidate 1 gets the budget and verifies; candidate 2 is untouched - no
  // attempt/reject/verify call for it at all.
  const verifiedCall = calls.find((c) => c.sql.includes('verified_at = now()'))
  expect(verifiedCall!.params).toEqual([1, 32, 9500, 'tavily', 'Genuine deal.'])
  expect(calls.some((c) => c.params[0] === 2)).toBe(false)
})

test('one candidate throwing unexpectedly is logged and skipped, not fatal to the rest', async () => {
  const clients: VerificationClients = {
    tavily: {
      search: async () => {
        throw new Error('boom')
      },
    },
    exa: { searchStructured: notImplemented },
    gemini: {
      generateJson: notImplemented,
      generateGroundedText: async () => {
        throw new Error('boom')
      },
    },
    openrouter: { generateJson: notImplemented },
  }
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  // verifyDiscountCandidate itself never throws (fails closed to 'pending'),
  // so this exercises the same path as the "no fresh data" test above, just
  // confirming the loop processes every candidate given, not just the first.
  await runVerifyDiscountNotifications(clients, db, logger, [
    candidate({ id: 1, listing_id: 'a' }),
    candidate({ id: 2, listing_id: 'b' }),
  ])

  const attemptCalls = calls.filter((c) => c.sql.includes('last_verification_attempt_at = now()'))
  expect(attemptCalls.map((c) => c.params)).toEqual([[1], [2]])
})
