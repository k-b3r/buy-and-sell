import type { DbClient, QueryClient } from '../../platform/storage'
import { queryDealListingIds, queryDeals } from './store/deals'
import type { DealsQuery } from './store/deals'

// Strongest evidence first.
export const DEALS_CONFIDENCE_TIERS = ['sold_comps', 'peer_listings', 'llm_estimate'] as const
export type DealsConfidenceTier = (typeof DEALS_CONFIDENCE_TIERS)[number]

export interface DealListing {
  listing_id: string
  title: string
  ask_price: number
  photo_url: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  reference_price: number | null
  tier: DealsConfidenceTier | null
  // Count of comparable listings behind the winning tier - sold listings for
  // sold_comps, active peer listings for peer_listings, null for
  // llm_estimate (nothing to count) or no tier at all.
  comp_count: number | null
  profit_pesos: number | null
  discount_percent: number | null
  days_listed: number | null
  is_saved: boolean
  is_low_confidence: boolean
}

export interface DealsDiscountPolicyFloors {
  minProfitPesos: number
  minPricePesos: number
}

export interface DealsFilters {
  search?: string
  categories?: string[]
  minProfitPesos?: number
  minConfidenceTier?: DealsConfidenceTier
  maxDaysListed?: number
  // Hours since our collector first saw the listing (first_seen_at), not the
  // seller's FB posting date that maxDaysListed uses.
  addedWithinHours?: number
  soldOnly?: boolean
  lowConfidenceOnly?: boolean
  offset?: number
  limit?: number
}

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
