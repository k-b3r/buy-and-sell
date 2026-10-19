import type { DealsConfidenceTier, DealsDiscountPolicyFloors, DealsFilters, DealsQuery } from '../types'

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
export function resolveDealsQuery(discountPolicy: DealsDiscountPolicyFloors, filters: DealsFilters): DealsQuery {
  return {
    ...filters,
    minProfitPesos: Math.max(discountPolicy.minProfitPesos, filters.minProfitPesos ?? 0),
    minPricePesos: discountPolicy.minPricePesos,
    offset: filters.offset ?? 0,
    limit: filters.limit ?? DEALS_DEFAULT_LIMIT,
  }
}
