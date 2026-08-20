import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient, createFallbackGeminiClient, isQuotaError } from './gemini'
import type { DbClient } from './db'
import { createDbPool, insertPriceCheck } from './db'
import { buildPriceLookupPrompt, parsePriceRangeResponse } from './pricing'

export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
}

// A market range is more meaningful with more than one data point, and it
// keeps the per-run request volume to a small, deliberately-scoped subset of
// the full product list rather than every single-listing product too.
export async function getPriceLookupCandidates(db: DbClient): Promise<PriceLookupCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier
     FROM products p
     JOIN listings l ON l.product_id = p.id
     GROUP BY p.id, p.base_model, p.variant_tier
     HAVING count(l.id) >= 2
     ORDER BY count(l.id) DESC`,
    [],
  )) as { rows: PriceLookupCandidate[] }
  return result.rows
}

export interface PriceLookupOptions {
  delayMs: number
}

export type DelayFn = (ms: number) => Promise<void>

const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Real, repeated live behavior (2026-08-20, 3 consecutive attempts): free-tier
// grounding on both configured accounts allows roughly one successful call,
// then locks out for an extended stretch — not a per-minute rate that more
// spacing between products fixes. So a quota error here doesn't fail the
// product or the run — it waits with growing backoff and retries the exact
// same call until it eventually goes through, however long that takes.
const INITIAL_QUOTA_BACKOFF_MS = 2 * 60 * 1000 // 2 min
const MAX_QUOTA_BACKOFF_MS = 30 * 60 * 1000 // 30 min

async function generateGroundedTextWithRetry(
  gemini: GeminiClient,
  prompt: string,
  logger: Logger,
  delay: DelayFn,
): Promise<string> {
  let backoffMs = INITIAL_QUOTA_BACKOFF_MS
  while (true) {
    try {
      return await gemini.generateGroundedText(prompt)
    } catch (err) {
      if (!isQuotaError(err)) throw err
      logger.warn(`quota exhausted, waiting ${backoffMs}ms before retrying this product`)
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, MAX_QUOTA_BACKOFF_MS)
    }
  }
}

// Grounding can't be combined with structured output (confirmed live — see
// src/gemini.ts), and unlike product extraction, a price lookup needs its
// own distinct search per product — no batching multiple products into one
// call. Each product is always re-checked (no "already done" skip): every
// run is meant to add a fresh point to the price trend, not just fill gaps.
export async function runPriceLookup(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  products: PriceLookupCandidate[],
  options: PriceLookupOptions,
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${products.length} products to price-check`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) {
      logger.info(`waiting ${options.delayMs}ms before next product`)
      await delay(options.delayMs)
    }

    const product = products[i]
    const label = product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model
    logger.info(`[${i + 1}/${products.length}] checking price for product ${product.id}: ${label}`)

    const prompt = buildPriceLookupPrompt(product.base_model, product.variant_tier)
    const text = await generateGroundedTextWithRetry(gemini, prompt, logger, delay)
    const price = parsePriceRangeResponse(text)

    if (!price) {
      logger.warn(`product ${product.id} (${label}): no parseable price range in response, skipping`)
      continue
    }

    await insertPriceCheck(db, product.id, price, text, 'gemini_grounding')
    logger.info(`product ${product.id} (${label}): ${price.low}-${price.high} ${price.currency}`)
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price lookup requires Postgres')

  const logger = createLogger('data/price-lookup.log')

  const altApiKey = process.env.ALT_FREE_GEMINI_API_KEY
  const gemini = altApiKey
    ? createFallbackGeminiClient([createGeminiClient(apiKey), createGeminiClient(altApiKey, 'gemini-3.6-flash')])
    : createGeminiClient(apiKey)
  if (altApiKey) {
    logger.info('ALT_FREE_GEMINI_API_KEY configured, will fall back to it (gemini-3.6-flash) on quota exhaustion')
  }

  const pool = createDbPool(dbUrl)

  try {
    const products = await getPriceLookupCandidates(pool)
    // Gemini 2.5 Flash's free tier is 5 RPM (confirmed live via the AI Studio
    // rate-limit dashboard, 2026-08-20) — unlike extraction's ~10 batched
    // requests total, price lookup is one sequential request per product, so
    // the per-minute cap actually matters here. 15s keeps us under 5 RPM with margin.
    await runPriceLookup(gemini, pool, logger, products, { delayMs: 15000 })
  } finally {
    await pool.end()
  }
  logger.info('price lookup complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
