import type { Logger } from '../../../platform/logger'
import type { DbClient } from '../../../platform/storage'
import type { PriceExclusionReason } from '../types'
import { PRICE_INELIGIBLE_CATEGORIES } from '../domain/ineligible-categories'
import { excludeFromPricing } from '../store/exclusion'

// One excludeFromPricing write per reason in the curated list above.
export async function excludeIneligibleCategories(db: DbClient, logger: Logger): Promise<void> {
  // Object.entries widens keys to string; the record's type already pins them.
  for (const [reason, baseModels] of Object.entries(PRICE_INELIGIBLE_CATEGORIES) as [
    PriceExclusionReason,
    string[],
  ][]) {
    await excludeFromPricing(db, { baseModels }, reason)
    logger.info(`flagged ${baseModels.length} base_model values as '${reason}'`)
  }
}
