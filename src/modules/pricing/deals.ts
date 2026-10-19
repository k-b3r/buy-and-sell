import type { DbClient, QueryClient } from '../../platform/storage'
import type { DealListing, DealsConfidenceTier, DealsDiscountPolicyFloors, DealsFilters } from './types'
import { queryDealListingIds, queryDeals } from './store/deals'
import type { DealsQuery } from './store/deals'

// Strongest evidence first.
export const DEALS_CONFIDENCE_TIERS = [
  'sold_comps',
  'peer_listings',
  'llm_estimate',
] as const satisfies readonly DealsConfidenceTier[]

const DEALS_DEFAULT_LIMIT = 30

// Policy floors are hard minimums, not defaults: a filter asking for less
// than the floor doesn't get to punch through it (min_profit_pesos and
// min_price_pesos are operator-tunable policy, not something this page's UI
// should be able to undercut). The ranking query itself is queryDeals
// (store/deals.ts).
function resolveDealsQuery(discountPolicy: DealsDiscountPolicyFloors, filters: DealsFilters): DealsQuery {
  return {
    ...filters,
    minProfitPesos: Math.max(discountPolicy.minProfitPesos, filters.minProfitPesos ?? 0),
    minPricePesos: discountPolicy.minPricePesos,
    offset: filters.offset ?? 0,
    limit: filters.limit ?? DEALS_DEFAULT_LIMIT,
  }
}

export async function getDeals(
  db: QueryClient,
  discountPolicy: DealsDiscountPolicyFloors,
  filters: DealsFilters = {},
): Promise<DealListing[]> {
  return queryDeals(db, resolveDealsQuery(discountPolicy, filters))
}

// Ids of the listings /deals currently ranks (main list, same filters and
// category cap), for check-listings to verify availability first. Same query
// as getDeals so "is a deal" has one definition.
export async function getDealListingIds(
  db: DbClient,
  discountPolicy: DealsDiscountPolicyFloors,
  limit: number,
): Promise<string[]> {
  return queryDealListingIds(db, resolveDealsQuery(discountPolicy, { limit }))
}
