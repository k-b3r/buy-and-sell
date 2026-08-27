import { fileURLToPath } from 'node:url'
import type { Logger } from '../../logger'
import { createLogger } from '../../logger'
import type { DbClient } from '../../storage'
import { createDbPool } from '../../storage'
import { loadEnvFile } from '../../utils'
import { insertPriceCheck } from '../../workers/secondhand-price-lookup/storage'
import type { PriceRange } from '../../pricing'
import type { ListingPricesForProductCondition } from './storage'
import { getListingPricesByProduct } from './storage'

// No real secondhand electronics listing on this marketplace goes below this
// — anything under it is a placeholder/joke price ("₱12", "₱20"), not a real
// ask, and would badly skew a naive min/max.
const JUNK_PRICE_FLOOR = 100

export function computePriceRangeFromPrices(prices: number[]): (PriceRange & { usedCount: number }) | null {
  const valid = prices.filter((p) => p >= JUNK_PRICE_FLOOR)
  if (valid.length < 2) return null
  return {
    low: Math.min(...valid),
    high: Math.max(...valid),
    currency: 'PHP',
    usedCount: valid.length,
  }
}

export type { ListingPricesForProductCondition }
export { getListingPricesByProduct }

// Pure local computation, no network calls, no quota — a free fill-in while
// Gemini grounding is quota-limited, not a replacement for it (see
// CONTEXT.md "Price history / market price lookup"). Instant for every
// candidate in one run, unlike the paced/rate-limited grounded lookup.
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
      logger.warn(`product ${group.id} (${label}, ${group.condition}): fewer than 2 valid prices after filtering junk, skipping`)
      continue
    }

    const note = `computed from ${range.usedCount} of ${group.prices.length} "${group.condition}" listings (junk prices excluded)`
    await insertPriceCheck(db, group.id, range, note, 'listing_prices', group.condition)
    inserted += 1
    logger.info(`product ${group.id} (${label}, ${group.condition}): ${range.low}-${range.high} PHP (${note})`)
  }

  logger.info(`done: ${inserted} product/condition ranges priced, ${skipped} skipped`)
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price-from-listings requires Postgres')

  const logger = createLogger('data/price-from-listings.log')
  const pool = createDbPool(dbUrl)

  try {
    const groups = await getListingPricesByProduct(pool)
    logger.info(`${groups.length} product/condition groups with 2+ listings to compute a price range for`)
    await runPriceFromListings(pool, logger, groups)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
