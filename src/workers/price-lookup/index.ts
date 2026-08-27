import { fileURLToPath } from 'node:url'
import type { Logger } from '../../logger'
import { createLogger } from '../../logger'
import type { GeminiClient } from '../../gemini'
import { createGeminiClient, createFallbackGeminiClient, isQuotaError } from '../../gemini'
import type { DbClient } from '../../storage/client'
import { createDbPool } from '../../storage/client'
import type { DelayFn } from '../../utils'
import { realDelay, loadEnvFile } from '../../utils'
import { buildPriceLookupPrompt, parsePriceRangeResponse } from '../../pricing'
import type { PriceLookupCandidate } from '../../pricing'
import { getPriceLookupCandidates, insertPriceCheck } from './storage'

export interface PriceLookupOptions {
  delayMs: number
}

// Real, repeated live behavior (2026-08-20, 3 consecutive attempts): free-tier
// grounding on both configured accounts allows roughly one successful call,
// then locks out for an extended stretch — not a per-minute rate that more
// spacing between products fixes. So a quota error here doesn't fail the
// batch or the run — it waits with growing backoff and retries the exact
// same call until it eventually goes through, however long that takes.
const INITIAL_QUOTA_BACKOFF_MS = 10 * 60 * 1000 // 10 min
const MAX_QUOTA_BACKOFF_MS = 60 * 60 * 1000 // 1 hour

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
      logger.warn(`quota exhausted, waiting ${backoffMs}ms before retrying this batch`)
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, MAX_QUOTA_BACKOFF_MS)
    }
  }
}

// Grounding can't be combined with structured output (confirmed live — see
// src/gemini.ts), so batches go through a fenced-json-in-free-text prompt
// (buildPriceLookupPrompt/parsePriceRangeResponse), same pattern as
// enrich-products.ts. Batching itself is a live-confirmed win, not a guess -
// two separate live tests (adversarial sibling products + unrelated
// cross-category products) both came back correct for all 5 products in one
// call, no cross-contamination. BATCH_SIZE=5 matches those tests exactly;
// higher N wasn't confirmed (blocked mid-test by Gemini's 20-req/day free
// quota) - revisit raising it once that's re-tested on a fresh day.
// Each product is always re-checked (no "already done" skip): every run is
// meant to add a fresh point to the price trend, not just fill gaps.
const BATCH_SIZE = 5

// Runs forever, not once - re-queries getPriceLookupCandidates every lap, same
// pattern as enrich-products.ts. Every product is always re-checked (no
// "already done" skip - see runPriceLookup above), so each lap just adds a
// fresh trend point to whatever's currently eligible.
const LOOP_DELAY_MS = 300000

export async function runPriceLookup(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  products: PriceLookupCandidate[],
  options: PriceLookupOptions,
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${products.length} products to price-check`)

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    if (i > 0) {
      logger.info(`waiting ${options.delayMs}ms before next batch`)
      await delay(options.delayMs)
    }

    const batch = products.slice(i, i + BATCH_SIZE)
    logger.info(`batch starting at product ${i}: checking prices for ${batch.length} products`)

    const prompt = buildPriceLookupPrompt(batch)
    const text = await generateGroundedTextWithRetry(gemini, prompt, logger, delay)
    const results = parsePriceRangeResponse(text)

    if (!results) {
      logger.error(`batch starting at product ${i}: unparseable response (no fenced json block), skipping batch`)
      continue
    }

    for (const product of batch) {
      const label = product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model
      const result = results.find((r) => r.id === String(product.id))

      if (!result || !result.found || result.price_low === null || result.price_high === null) {
        logger.warn(`product ${product.id} (${label}): no parseable/found price range in response, skipping`)
        continue
      }

      await insertPriceCheck(
        db,
        product.id,
        { low: result.price_low, high: result.price_high, currency: result.currency ?? 'PHP' },
        text,
        'gemini_grounding',
      )
      logger.info(`product ${product.id} (${label}): ${result.price_low}-${result.price_high} ${result.currency}`)
    }
  }
}

async function main() {
  loadEnvFile()
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

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const products = await getPriceLookupCandidates(pool)
      // Gemini 2.5 Flash's free tier is 5 RPM (confirmed live via the AI Studio
      // rate-limit dashboard, 2026-08-20) — this is per call now, not per
      // product (BATCH_SIZE=5 products/call), so the same 15s pacing covers 5x
      // the throughput it used to. 15s keeps us under 5 RPM with margin.
      await runPriceLookup(gemini, pool, logger, products, { delayMs: 15000 })
      logger.info(`lap ${lap} complete, sleeping ${LOOP_DELAY_MS}ms`)
      lap++
      await realDelay(LOOP_DELAY_MS)
    }
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
