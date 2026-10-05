import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { updateProductCategories } from './product-storage'
import { buildCategoryBackfillPrompt, CATEGORY_BACKFILL_RESPONSE_SCHEMA, isProductCategory } from './products'
import type { CategoryBackfillCandidate } from './products'

// Output per item here is just {id, category} — far smaller than
// enrich-products.ts's multi-field payload, so this tolerates a much larger
// batch than that script's tested 20. Not yet re-verified live against a
// real batch at this size; adjust down if a run hits truncation.
const BATCH_SIZE = 100

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

interface RawCategoryItem {
  id?: unknown
  category?: unknown
}

// I/O for both category backfills (see sub-category-backfill.ts).
export interface CategoryBackfillIo {
  groq: GroqClient
  db: DbClient
  logger: Logger
  delay?: DelayFn
}

export async function runCategoryBackfill(
  { groq, db, logger, delay = realDelay }: CategoryBackfillIo,
  candidates: CategoryBackfillCandidate[],
): Promise<void> {
  logger.info(`${candidates.length} products to categorize`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildCategoryBackfillPrompt(batch)

    let raw: { results?: unknown } | undefined
    try {
      raw = (await withRetry(() => groq.generateJson(prompt, CATEGORY_BACKFILL_RESPONSE_SCHEMA), {
        provider: 'Groq',
        label: `batch starting at ${i}`,
        maxAttempts: MAX_ATTEMPTS,
        retryDelayMs: RETRY_DELAY_MS,
        delay,
        logger,
      })) as { results?: unknown }
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        logger.error(`batch starting at ${i}: Groq quota exhausted (${err.message}), stopping run`)
      } else if (err instanceof RetriesExhaustedError) {
        logger.error(
          `batch starting at ${i}: Groq request failed after ${MAX_ATTEMPTS} attempts (${err.message}), stopping run`,
        )
      } else {
        throw err
      }
      break
    }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    const assignments: { id: number; category: string }[] = []
    for (const item of raw.results as RawCategoryItem[]) {
      if (typeof item.id !== 'string' || !isProductCategory(item.category)) {
        const idHint = typeof item.id === 'string' ? item.id : '(missing/invalid id)'
        logger.warn(`item ${idHint}: malformed fields in Groq response, skipping`)
        continue
      }
      const candidate = batch.find((c) => String(c.id) === item.id)
      if (!candidate) {
        logger.warn(`item ${item.id}: no matching candidate in this batch, skipping`)
        continue
      }
      assignments.push({ id: candidate.id, category: item.category })
    }

    await updateProductCategories(db, assignments)
    logger.info(`batch starting at ${i}: ${assignments.length}/${batch.length} products categorized`)
  }
}
