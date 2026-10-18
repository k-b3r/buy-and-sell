import type { DbClient } from '../../platform/storage'
import { getDealListingIds } from '../pricing'
import { putDealsFirst } from './listings'
import { getCheckListingsCandidates, getDealCheckCandidates } from './store/listings'
import type { CheckListingsCandidate } from './store/listings'

// How many top-ranked /deals listings are considered for priority checking.
const DEALS_PRIORITY_POOL = 200

// What one check-listings lap should check, in order. The backlog (see
// getCheckListingsCandidates) is always the base. With
// check_listings.deals_priority_enabled, listings /deals currently ranks are
// moved to the front, so a live deal is verified before the backlog.
//
// Lives here rather than in the check-listings worker entry: which candidates
// a lap picks is a domain decision, not wiring (CODING_STANDARDS.md keeps
// entry points thin).
export async function selectCheckCandidates(
  db: DbClient,
  settings: Record<string, number>,
  limit: number,
): Promise<CheckListingsCandidate[]> {
  const backlog = await getCheckListingsCandidates(db, limit, settings['check_listings.re_recheck_min_days'])
  if (settings['check_listings.deals_priority_enabled'] < 1) return backlog

  const dealIds = await getDealListingIds(
    db,
    {
      minProfitPesos: settings['discount_policy.min_profit_pesos'],
      minPricePesos: settings['discount_policy.min_price_pesos'],
    },
    DEALS_PRIORITY_POOL,
  )
  const deals = await getDealCheckCandidates(db, dealIds, settings['check_listings.deals_recheck_min_hours'])
  return putDealsFirst(deals, backlog, limit)
}
