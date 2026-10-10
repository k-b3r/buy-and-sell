import { expect, test } from 'vitest'
import { TIER_RANK_SQL } from './pricing-sql'

test('TIER_RANK_SQL ranks sold comps above peer listings and estimates', () => {
  expect(TIER_RANK_SQL).toContain("'sold_comps' THEN 3")
  expect(TIER_RANK_SQL).toContain("'peer_listings' THEN 2")
})
