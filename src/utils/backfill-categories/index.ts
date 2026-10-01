import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile } from '../../platform/utils'
import { getCategoryBackfillCandidates, updateProductCategories } from '../../domains/marketplace/storage/products'
import {
  buildCategoryBackfillPrompt,
  CATEGORY_BACKFILL_RESPONSE_SCHEMA,
  PRODUCT_CATEGORIES,
} from '../../domains/marketplace'
import type { CategoryBackfillCandidate } from '../../domains/marketplace'

// Output per item here is just {id, category} — far smaller than
// enrich-products.ts's multi-field payload, so this tolerates a much larger
// batch than that script's tested 20. Not yet re-verified live against a
// real batch at this size; adjust down if a run hits truncation.
const BATCH_SIZE = 100

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

const VALID_CATEGORIES = new Set<string>(PRODUCT_CATEGORIES)

interface RawCategoryItem {
  id?: unknown
  category?: unknown
}

export async function runCategoryBackfill(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: CategoryBackfillCandidate[],
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${candidates.length} products to categorize`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildCategoryBackfillPrompt(batch)

    let raw: { results?: unknown } | undefined
    let fatal = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        raw = (await groq.generateJson(prompt, CATEGORY_BACKFILL_RESPONSE_SCHEMA)) as { results?: unknown }
        break
      } catch (err) {
        const status = (err as { status?: unknown }).status
        const message = summarizeGroqError(err)
        if (status === 429) {
          logger.error(`batch starting at ${i}: Groq quota exhausted (${message}), stopping run`)
          fatal = true
          break
        }
        if (attempt === MAX_ATTEMPTS) {
          logger.error(
            `batch starting at ${i}: Groq request failed after ${MAX_ATTEMPTS} attempts (${message}), stopping run`,
          )
          fatal = true
          break
        }
        logger.warn(`batch starting at ${i}: Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message})`)
        await delay(RETRY_DELAY_MS)
      }
    }
    if (fatal) break

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    const assignments: { id: number; category: string }[] = []
    for (const item of raw.results as RawCategoryItem[]) {
      if (typeof item.id !== 'string' || typeof item.category !== 'string' || !VALID_CATEGORIES.has(item.category)) {
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

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys()
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — category backfill requires Postgres')

  const logger = createLogger('data/backfill-categories.log')
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
    logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
  )
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getCategoryBackfillCandidates(pool)
    await runCategoryBackfill(groq, pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('category backfill complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// see enrich-products.ts for the same precedent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
