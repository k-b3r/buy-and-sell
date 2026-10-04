import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { loadEnvFile } from '../../platform/env'
import { getSubCategoryBackfillCandidates, updateProductSubCategories } from '../../domains/marketplace'
import {
  buildSubCategoryBackfillPrompt,
  SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA,
  SUB_CATEGORIES,
} from '../../domains/marketplace'
import type { SubCategoryBackfillCandidate } from '../../domains/marketplace'

// Mirrors backfill-categories/index.ts exactly - same output shape class
// ({id, sub_category} per item), same batch size reasoning.
const BATCH_SIZE = 50

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

const VALID_SUB_CATEGORIES = new Set<string>(SUB_CATEGORIES)

interface RawSubCategoryItem {
  id?: unknown
  sub_category?: unknown
}

// Thrown to unwind out of the recursion below and stop the whole run — a
// 429 means the key itself is dead, which says nothing about batch size and
// isn't fixed by retrying smaller.
class QuotaExhaustedError extends Error {}

function parseAssignments(
  raw: { results?: unknown } | undefined,
  batch: SubCategoryBackfillCandidate[],
  logger: Logger,
  offset: number,
): { id: number; subCategory: string }[] {
  if (!raw || !Array.isArray(raw.results)) {
    logger.error(`batch starting at ${offset}: unexpected response shape (no results array), skipping batch`)
    return []
  }
  const assignments: { id: number; subCategory: string }[] = []
  for (const item of raw.results as RawSubCategoryItem[]) {
    if (
      typeof item.id !== 'string' ||
      typeof item.sub_category !== 'string' ||
      !VALID_SUB_CATEGORIES.has(item.sub_category)
    ) {
      const idHint = typeof item.id === 'string' ? item.id : '(missing/invalid id)'
      logger.warn(`item ${idHint}: malformed fields in Groq response, skipping`)
      continue
    }
    const candidate = batch.find((c) => String(c.id) === item.id)
    if (!candidate) {
      logger.warn(`item ${item.id}: no matching candidate in this batch, skipping`)
      continue
    }
    assignments.push({ id: candidate.id, subCategory: item.sub_category })
  }
  return assignments
}

// Recurses on a persistent non-quota failure by halving the batch and
// retrying each half independently (its own fresh MAX_ATTEMPTS budget) -
// confirmed live 2026-08-28: gpt-oss-120b occasionally wraps a 100-item
// results array as {results: {items: [...]}} instead of a flat array, which
// Groq's own strict-mode schema validator rejects as a 400 before any
// content comes back. A smaller array gives the model less room to lose
// track of the shape mid-generation, so halving is a real mitigation, not
// just spreading the same odds across more calls. Only gives up (skips)
// once a single item alone still fails 3 times — genuinely rare, and it
// stays sub_category_id IS NULL for the next run to pick up.
async function attemptBatch(
  groq: GroqClient,
  logger: Logger,
  delay: DelayFn,
  batch: SubCategoryBackfillCandidate[],
  offset: number,
): Promise<{ id: number; subCategory: string }[]> {
  const prompt = buildSubCategoryBackfillPrompt(batch)
  let raw: { results?: unknown } | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      raw = (await groq.generateJson(prompt, SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA)) as { results?: unknown }
      break
    } catch (err) {
      const status = (err as { status?: unknown }).status
      const message = summarizeGroqError(err)
      if (status === 429) {
        logger.error(`batch starting at ${offset}: Groq quota exhausted (${message}), stopping run`)
        throw new QuotaExhaustedError(message)
      }
      if (attempt === MAX_ATTEMPTS) {
        if (batch.length === 1) {
          logger.error(
            `item ${batch[0].id}: Groq request failed after ${MAX_ATTEMPTS} attempts even at batch size 1 (${message}), skipping`,
          )
          return []
        }
        const mid = Math.ceil(batch.length / 2)
        logger.error(
          `batch starting at ${offset}: Groq request failed after ${MAX_ATTEMPTS} attempts at batch size ${batch.length} (${message}), splitting into ${mid} + ${batch.length - mid} and retrying`,
        )
        const first = await attemptBatch(groq, logger, delay, batch.slice(0, mid), offset)
        const second = await attemptBatch(groq, logger, delay, batch.slice(mid), offset + mid)
        return [...first, ...second]
      }
      logger.warn(`batch starting at ${offset}: Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message})`)
      await delay(RETRY_DELAY_MS)
    }
  }

  return parseAssignments(raw, batch, logger, offset)
}

export async function runSubCategoryBackfill(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: SubCategoryBackfillCandidate[],
  delay: DelayFn = realDelay,
  batchSize: number = BATCH_SIZE,
): Promise<void> {
  logger.info(`${candidates.length} products to sub-categorize`)

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    let assignments: { id: number; subCategory: string }[]
    try {
      assignments = await attemptBatch(groq, logger, delay, batch, i)
    } catch (err) {
      if (err instanceof QuotaExhaustedError) break
      throw err
    }

    await updateProductSubCategories(db, assignments)
    logger.info(`batch starting at ${i}: ${assignments.length}/${batch.length} products sub-categorized`)
  }
}

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys(process.env)
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — sub-category backfill requires Postgres')

  const logger = createLogger('data/backfill-sub-categories.log')
  // See createGroqPool - per-key model fallback round-robined across keys,
  // logging every hop.
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
    logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
  )
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getSubCategoryBackfillCandidates(pool)
    await runSubCategoryBackfill(groq, pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('sub-category backfill complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// see enrich-products.ts for the same precedent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
