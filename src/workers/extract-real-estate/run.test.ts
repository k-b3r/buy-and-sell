import { existsSync, rmSync } from 'node:fs'
import { runRealEstateExtraction } from './run'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { JsonModelClient, RealEstateCandidate } from '../../modules/real-estate'

const LOG_PATH = 'data/tmp-run-extract-real-estate.log'
afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

const noDelay = async () => {}
const cand = (id: string, over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id,
  title: 'Condo for sale Makati',
  description: null,
  price_amount: 4500000,
  source_hash: `hash-${id}`,
  ...over,
})
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 4500000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: null,
  area_text: 'Makati',
  tags: [],
  confidence: 'high',
  ...over,
})

test('runRealEstateExtraction upserts each extracted listing with its source hash', async () => {
  const params: unknown[][] = []
  const db: DbClient = {
    query: async (_sql: string, p: unknown[]) => {
      params.push(p)
      return { rows: [] }
    },
  }
  const groq: JsonModelClient = { generateJson: async () => ({ results: [item('1')] }) }

  await runRealEstateExtraction({ groq, db, logger: createLogger(LOG_PATH), delay: noDelay }, [cand('1')], 20)

  expect(params).toHaveLength(1)
  expect(params[0][0]).toBe('1')
  expect(params[0][13]).toBe('hash-1')
  expect(params[0][14]).toBe('openai/gpt-oss-120b')
})
