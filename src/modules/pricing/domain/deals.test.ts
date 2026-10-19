import { expect, test } from 'vitest'
import { DEALS_CONFIDENCE_TIERS, resolveDealsQuery } from './deals'

const floors = { minProfitPesos: 1000, minPricePesos: 500 }

test('resolveDealsQuery keeps the policy profit floor when the filter asks for less', () => {
  expect(resolveDealsQuery(floors, { minProfitPesos: 200 }).minProfitPesos).toBe(1000)
  expect(resolveDealsQuery(floors, { minProfitPesos: 2000 }).minProfitPesos).toBe(2000)
})

test('resolveDealsQuery takes the price floor from policy and defaults paging to 30 from 0', () => {
  expect(resolveDealsQuery(floors, {})).toEqual({ minProfitPesos: 1000, minPricePesos: 500, offset: 0, limit: 30 })
  expect(resolveDealsQuery(floors, { limit: 5, offset: 10 })).toMatchObject({ limit: 5, offset: 10 })
})

test('DEALS_CONFIDENCE_TIERS lists the strongest evidence first', () => {
  expect(DEALS_CONFIDENCE_TIERS).toEqual(['sold_comps', 'peer_listings', 'llm_estimate'])
})
