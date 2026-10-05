import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from '../../modules/pricing'
import type { PriceReviewCandidate } from '../../modules/pricing'
import { getPriceReviewCandidates, upsertListingPriceReview } from '../../modules/pricing'

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

      await upsertListingPriceReview(db, {
        listingId: candidate.id,
        data: { isNegotiable: item.is_negotiable, priceLow, priceHigh, reasoning: item.reasoning },
        model: MODEL,
        reviewedDescription: candidate.description,
      })
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

  await runWorker({
    name: 'enrich-listing-prices',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: ['enrich_listing_prices.batch_size', 'enrich_listing_prices.loop_delay_ms'],
    loopDelayKey: 'enrich_listing_prices.loop_delay_ms',
    setup: ({ logger, db }) => {
      const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
        logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
      )
      logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
      return async ({ settings }) => {
        const candidates = await getPriceReviewCandidates(db)
        return {
          dryRun: `marketplace will call Groq for price review on ${candidates.length} listings this lap`,
          run: () => runPriceReview(groq, db, logger, candidates, settings['enrich_listing_prices.batch_size']),
        }
      }
    },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
