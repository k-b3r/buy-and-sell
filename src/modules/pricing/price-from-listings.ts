import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { ListingPricesForProductCondition } from './price-history'
import { insertPriceCheck } from './price-history'
import type { PriceRange } from './price-lookup'
import { isJunkPrice, MIN_PEER_SAMPLE } from './clean-median'

// Junk prices would badly skew a naive min/max.
export function computePriceRangeFromPrices(prices: number[]): (PriceRange & { usedCount: number }) | null {
  const valid = prices.filter((p) => !isJunkPrice(p))
  if (valid.length < MIN_PEER_SAMPLE) return null
  return {
    low: Math.min(...valid),
    high: Math.max(...valid),
    currency: 'PHP',
    usedCount: valid.length,
  }
}

// Pure local computation, no network calls, no quota — a free fill-in while
// Gemini grounding is quota-limited, not a replacement for it (see
// CONTEXT.md "Price history / market price lookup"). Instant for every
// candidate in one run, unlike the paced/rate-limited grounded lookup.
// Groups come from getListingPricesByProduct.
export async function runPriceFromListings(
  db: DbClient,
  logger: Logger,
  groups: ListingPricesForProductCondition[],
): Promise<void> {
  let inserted = 0
  let skipped = 0

  for (const group of groups) {
    const label = group.variant_tier ? `${group.base_model} (${group.variant_tier})` : group.base_model
    const range = computePriceRangeFromPrices(group.prices)

    if (!range) {
      skipped += 1
      logger.warn(
        `product ${group.id} (${label}, ${group.condition}): fewer than ${MIN_PEER_SAMPLE} valid prices after filtering junk, skipping`,
      )
      continue
    }

    const note = `computed from ${range.usedCount} of ${group.prices.length} "${group.condition}" listings (junk prices excluded)`
    await insertPriceCheck(db, {
      productId: group.id,
      price: range,
      rawResponse: note,
      source: 'listing_prices',
      condition: group.condition,
    })
    inserted += 1
    logger.info(`product ${group.id} (${label}, ${group.condition}): ${range.low}-${range.high} PHP (${note})`)
  }

  logger.info(`done: ${inserted} product/condition ranges priced, ${skipped} skipped`)
}
