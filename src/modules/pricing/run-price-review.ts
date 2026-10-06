import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../platform/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from './price-review'
import type { PriceReviewCandidate } from './price-review'
import { upsertListingPriceReview } from './listing-price-review'

const DEFAULT_BATCH_SIZE = 35
const MODEL = 'openai/gpt-oss-120b'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

interface RawPriceReviewItem {
  id?: unknown
  is_negotiable?: unknown
  price_low?: unknown
  price_high?: unknown
  reasoning?: unknown
}

export interface PriceReviewDeps {
  groq: GroqClient
  db: DbClient
  logger: Logger
  delay?: DelayFn
}

// Same retry-then-stop as product enrichment (catalog/run-enrichment.ts):
// transient failures are retried, a quota error or exhausted retries end the
// run, and unreviewed listings stay candidates for the next lap. Null means
// stop.
async function requestPriceReview(
  { groq, logger, delay }: Required<Pick<PriceReviewDeps, 'groq' | 'logger' | 'delay'>>,
  prompt: string,
  label: string,
): Promise<{ results?: unknown } | null> {
  try {
    return (await withRetry(() => groq.generateJson(prompt, PRICE_REVIEW_RESPONSE_SCHEMA), {
      provider: 'Groq',
      label,
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS,
      delay,
      logger,
    })) as { results?: unknown }
  } catch (err) {
    if (!(err instanceof QuotaExhaustedError || err instanceof RetriesExhaustedError)) throw err
    const reason =
      err instanceof QuotaExhaustedError ? 'quota exhausted' : `request failed after ${MAX_ATTEMPTS} attempts`
    logger.error(`${label}: Groq ${reason} (${err.message}), stopping run`)
    return null
  }
}

export async function runPriceReview(
  deps: PriceReviewDeps,
  candidates: PriceReviewCandidate[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<void> {
  const { groq, db, logger, delay = realDelay } = deps
  logger.info(`${candidates.length} listings to price-review`)

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const prompt = buildPriceReviewPrompt(batch)

    const raw = await requestPriceReview({ groq, logger, delay }, prompt, `batch starting at ${i}`)
    if (raw === null) break

    if (!Array.isArray(raw?.results)) {
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
