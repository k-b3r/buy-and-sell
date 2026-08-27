import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { realDelay, loadEnvFile } from '../../platform/utils'
import { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from '../../price-review'
import type { PriceReviewCandidate } from '../../price-review'
import { getPriceReviewCandidates, upsertListingPriceReview } from './storage'

const BATCH_SIZE = 35
const MODEL = 'openai/gpt-oss-120b'

// Runs forever, not once - re-queries getPriceReviewCandidates every lap, same
// pattern as enrich-products.ts. New price-outlier listings appear over time
// as check-listings.ts/collect.ts add more data, so this needs to keep polling.
const LOOP_DELAY_MS = 300000

interface RawPriceReviewItem {
  id?: unknown
  is_negotiable?: unknown
  price_low?: unknown
  price_high?: unknown
  reasoning?: unknown
}

export async function runPriceReview(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: PriceReviewCandidate[],
): Promise<void> {
  logger.info(`${candidates.length} listings to price-review`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildPriceReviewPrompt(batch)

    let raw: { results?: unknown }
    try {
      raw = (await groq.generateJson(prompt, PRICE_REVIEW_RESPONSE_SCHEMA)) as { results?: unknown }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`batch starting at ${i}: Groq request failed (${message}), stopping run`)
      break
    }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    for (const item of raw.results as RawPriceReviewItem[]) {
      if (typeof item.id !== 'string' || typeof item.is_negotiable !== 'boolean' || typeof item.reasoning !== 'string') {
        const idHint = typeof item.id === 'string' ? item.id : '(missing/invalid id)'
        logger.warn(`item ${idHint}: malformed fields in Groq response, skipping`)
        continue
      }
      const candidate = batch.find((c) => c.id === item.id)
      if (!candidate) {
        logger.warn(`item ${item.id}: no matching candidate in this batch, skipping`)
        continue
      }

      const priceLow = typeof item.price_low === 'number' ? item.price_low : null
      const priceHigh = typeof item.price_high === 'number' ? item.price_high : null

      await upsertListingPriceReview(
        db,
        candidate.id,
        { isNegotiable: item.is_negotiable, priceLow, priceHigh, reasoning: item.reasoning },
        MODEL,
      )
      logger.info(`listing ${candidate.id} price-reviewed (negotiable: ${item.is_negotiable})`)
    }
  }
}

async function main() {
  loadEnvFile()
  const apiKey = process.env.FREE_GROQ_API_KEY
  if (!apiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price review requires Postgres')

  const logger = createLogger('data/enrich-listing-prices.log')
  const groq = createGroqClient(apiKey, MODEL)
  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getPriceReviewCandidates(pool)
      await runPriceReview(groq, pool, logger, candidates)
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
