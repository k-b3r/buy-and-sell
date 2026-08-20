import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { DbClient } from './db'
import { createDbPool, insertPriceCheck } from './db'
import type { PriceRange } from './pricing'

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

export interface ListingPricesForProduct {
  id: number
  base_model: string
  variant_tier: string | null
  prices: number[]
}

// Same 2+ listings scope as the Gemini-grounded lookup — a range needs more
// than one data point to mean anything, regardless of the source.
export async function getListingPricesByProduct(db: DbClient): Promise<ListingPricesForProduct[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, array_agg(l.price_amount) AS prices
     FROM products p
     JOIN listings l ON l.product_id = p.id
     WHERE l.price_amount IS NOT NULL
     GROUP BY p.id, p.base_model, p.variant_tier
     HAVING count(l.id) >= 2
     ORDER BY count(l.id) DESC`,
    [],
  )) as { rows: { id: number; base_model: string; variant_tier: string | null; prices: string[] }[] }
  return result.rows.map((r) => ({
    id: r.id,
    base_model: r.base_model,
    variant_tier: r.variant_tier,
    prices: r.prices.map(Number),
  }))
}

// Pure local computation, no network calls, no quota — a free fill-in while
// Gemini grounding is quota-limited, not a replacement for it (see
// CONTEXT.md "Price history / market price lookup"). Instant for every
// candidate in one run, unlike the paced/rate-limited grounded lookup.
export async function runPriceFromListings(
  db: DbClient,
  logger: Logger,
  products: ListingPricesForProduct[],
): Promise<void> {
  let inserted = 0
  let skipped = 0

  for (const product of products) {
    const label = product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model
    const range = computePriceRangeFromPrices(product.prices)

    if (!range) {
      skipped += 1
      logger.warn(`product ${product.id} (${label}): fewer than 2 valid prices after filtering junk, skipping`)
      continue
    }

    const note = `computed from ${range.usedCount} of ${product.prices.length} listings (junk prices excluded)`
    await insertPriceCheck(db, product.id, range, note, 'listing_prices')
    inserted += 1
    logger.info(`product ${product.id} (${label}): ${range.low}-${range.high} PHP (${note})`)
  }

  logger.info(`done: ${inserted} products priced, ${skipped} skipped`)
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price-from-listings requires Postgres')

  const logger = createLogger('data/price-from-listings.log')
  const pool = createDbPool(dbUrl)

  try {
    const products = await getListingPricesByProduct(pool)
    logger.info(`${products.length} products with 2+ listings to compute a price range for`)
    await runPriceFromListings(pool, logger, products)
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
