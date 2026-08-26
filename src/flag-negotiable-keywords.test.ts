import { existsSync, rmSync } from 'node:fs'
import { runFlagNegotiableKeywords } from './flag-negotiable-keywords'
import { createLogger } from './logger'
import type { DbClient, NegotiableKeywordCandidate } from './db'

const LOG_PATH = 'data/tmp-flag-negotiable-keywords.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeDb(): { db: DbClient; upserts: unknown[][] } {
  const upserts: unknown[][] = []
  return {
    upserts,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        upserts.push(params)
        return { rows: [] }
      },
    },
  }
}

test('flags listings whose title or description matches a negotiability keyword', async () => {
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: NegotiableKeywordCandidate[] = [
    { id: '1', title: 'RTX 3060', description: 'Nego pa presyo' },
    { id: '2', title: 'PS5 Slim, price OBO', description: null },
  ]

  const flagged = await runFlagNegotiableKeywords(db, logger, candidates)

  expect(flagged).toBe(2)
  expect(upserts).toEqual([
    ['1', 'keyword match: "nego"'],
    ['2', 'keyword match: "obo"'],
  ])
})

test('skips listings with no negotiability signal, no db call made', async () => {
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: NegotiableKeywordCandidate[] = [{ id: '1', title: 'Sony WH-1000XM6, barely used', description: null }]

  const flagged = await runFlagNegotiableKeywords(db, logger, candidates)

  expect(flagged).toBe(0)
  expect(upserts).toHaveLength(0)
})

test('mixed batch only upserts the matching listings', async () => {
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: NegotiableKeywordCandidate[] = [
    { id: '1', title: 'iPhone 13', description: 'clean unit no issues' },
    { id: '2', title: 'iPhone 14', description: 'open to offers' },
  ]

  const flagged = await runFlagNegotiableKeywords(db, logger, candidates)

  expect(flagged).toBe(1)
  expect(upserts).toEqual([['2', 'keyword match: "open to offers"']])
})
