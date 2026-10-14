import { expect, test } from 'vitest'
import { getDealListingIds, getDeals } from './deals'
import type { QueryClient } from '../../platform/storage'

const DEFAULT_DISCOUNT_POLICY_FLOORS = { minProfitPesos: 1000, minPricePesos: 500 }

test('getDeals raises the profit floor when a higher minProfitPesos filter is passed, without lowering the policy floor', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getDeals(db, DEFAULT_DISCOUNT_POLICY_FLOORS, { minProfitPesos: 2000 })
  expect(capturedParams).toContain(2000)
  expect(capturedParams).not.toContain(1000)

  await getDeals(db, DEFAULT_DISCOUNT_POLICY_FLOORS, { minProfitPesos: 500 })
  expect(capturedParams).toContain(1000) // policy floor wins - filter can't go below it
})

test('getDeals pages 30 from the start by default and passes the policy price floor through', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getDeals(db, { minProfitPesos: 1000, minPricePesos: 750 })

  // placeholders in push order: minProfit, minPrice, minTierRank, lowConfidenceOnly, limit, offset, category cap
  expect(capturedParams).toEqual([1000, 750, 0, false, 30, 0, 10])
})

test('getDealListingIds returns the ranked main-list deal ids up to the limit', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return {
        rows: [
          { listing_id: 'l1', ask_price: '1' },
          { listing_id: 'l2', ask_price: '1' },
        ],
      }
    },
  }

  const ids = await getDealListingIds(db, DEFAULT_DISCOUNT_POLICY_FLOORS, 200)

  expect(ids).toEqual(['l1', 'l2'])
  expect(capturedParams).toContain(200)
})
