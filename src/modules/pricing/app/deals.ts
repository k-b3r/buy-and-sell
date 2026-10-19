import type { DbClient, QueryClient } from '../../../platform/storage'
import type { DealListing, DealsDiscountPolicyFloors, DealsFilters } from '../types'
import { resolveDealsQuery } from '../domain/deals'
import { queryDealListingIds, queryDeals } from '../store/deals'

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
