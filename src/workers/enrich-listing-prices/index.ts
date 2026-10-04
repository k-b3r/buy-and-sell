import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from '../../domains/marketplace'
import type { PriceReviewCandidate } from '../../domains/marketplace'
import { getPriceReviewCandidates, upsertListingPriceReview } from '../../domains/marketplace'
import { loadSettings } from '../../platform/settings'

const DEFAULT_BATCH_SIZE = 35
const MODEL = 'openai/gpt-oss-120b'

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
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<void> {
  logger.info(`${candidates.length} listings to price-review`)

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const prompt = buildPriceReviewPrompt(batch)

    let raw: { results?: unknown }
    try {
      raw = (await groq.generateJson(prompt, PRICE_REVIEW_RESPONSE_SCHEMA)) as { results?: unknown }
    } catch (err) {
      logger.error(`batch starting at ${i}: Groq request failed (${summarizeGroqError(err)}), stopping run`)
      break
    }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    for (const item of raw.results as RawPriceReviewItem[]) {
      if (
        typeof item.id !== 'string' ||
        typeof item.is_negotiable !== 'boolean' ||
        typeof item.reasoning !== 'string'
      ) {
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
        candidate.description,
      )
      logger.info(`listing ${candidate.id} price-reviewed (negotiable: ${item.is_negotiable})`)
    }
  }
}

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys(process.env)
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price review requires Postgres')

  const logger = createLogger('data/enrich-listing-prices.log')
  writePidFile('data/enrich-listing-prices.pid')
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
    logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
  )
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getPriceReviewCandidates(pool)
      const settings = await loadSettings(pool, [
        'enrich_listing_prices.batch_size',
        'enrich_listing_prices.loop_delay_ms',
      ])
      if (isTestRun(process.env)) {
        logger.info(`TEST_RUN: marketplace will call Groq for price review on ${candidates.length} listings this lap`)
      } else {
        await runPriceReview(groq, pool, logger, candidates, settings['enrich_listing_prices.batch_size'])
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['enrich_listing_prices.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['enrich_listing_prices.loop_delay_ms'])
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
