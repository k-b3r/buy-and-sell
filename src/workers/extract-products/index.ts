import { fileURLToPath } from 'node:url'
import type { Logger } from '../../logger'
import { createLogger } from '../../logger'
import type { GeminiClient } from '../../gemini'
import { createGeminiClient, createFallbackGeminiClient, isQuotaError } from '../../gemini'
import type { DbClient } from '../../storage/client'
import { createDbPool } from '../../storage/client'
import type { DelayFn } from '../../utils'
import { realDelay, loadEnvFile } from '../../utils'
import type { ExtractionCandidate } from './storage'
import { findOrCreateProduct, updateListingProductIds, getExtractionCandidates } from './storage'
import {
  buildExtractionPrompt,
  EXTRACTION_RESPONSE_SCHEMA,
  normalizeBaseModel,
  normalizeVariantTier,
  PRODUCT_CATEGORIES,
} from '../../products'
import { CANONICAL_BASE_MODEL } from '../merge-duplicate-products'

export interface ExtractionOptions {
  batchSize: number
  delayMs?: number
}

// Gemini's free tier throws real 503s under load ("This model is currently
// experiencing high demand... usually temporary") — confirmed live
// 2026-08-24 on Hetzner, which crashed the whole run uncaught. Exponential
// backoff starting at 30s (not enrich-products.ts's 3s) because "usually
// temporary" for a model-capacity spike plausibly means minutes, not
// seconds — 5 attempts caps the wait at 30+60+120+240 = ~7.5 minutes before
// giving up. A real quota error (429, all fallback keys exhausted) is not
// retried — same reasoning as enrich-products.ts, retrying can't fix an
// exhausted quota.
const MAX_ATTEMPTS = 5
const RETRY_BASE_DELAY_MS = 30000

// Runs forever, not once - re-queries getExtractionCandidates every lap so
// newly-collected listings (collect.ts adds more over time) get picked up
// without a restart, same pattern as enrich-products.ts.
const LOOP_DELAY_MS = 300000

export async function runProductExtraction(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  candidates: ExtractionCandidate[],
  options: ExtractionOptions,
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${candidates.length} listings pending product extraction`)

  // Caches base_model -> product_id across the whole run (not just one batch) — many
  // listings share a base_model, and each cache hit avoids a real Postgres round trip.
  const productIdCache = new Map<string, number>()
  const delayMs = options.delayMs ?? 5000
  const totalBatches = Math.ceil(candidates.length / options.batchSize)
  let processedSoFar = 0

  for (let i = 0; i < candidates.length; i += options.batchSize) {
    const batchNum = i / options.batchSize + 1
    if (i > 0) {
      logger.info(`waiting ${delayMs}ms before next batch`)
      await delay(delayMs)
    }
    const batch = candidates.slice(i, i + options.batchSize)
    logger.info(`batch ${batchNum}/${totalBatches}: sending ${batch.length} listings to Gemini`)
    const prompt = buildExtractionPrompt(batch.map((c) => ({ id: c.id, title: c.title, description: c.description ?? '' })))

    let raw: unknown
    let fatal = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        raw = await gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isQuotaError(err)) {
          logger.error(`batch ${batchNum}/${totalBatches}: Gemini quota exhausted across all configured keys (${message}), stopping run`)
          fatal = true
          break
        }
        if (attempt === MAX_ATTEMPTS) {
          logger.error(`batch ${batchNum}/${totalBatches}: Gemini request failed after ${MAX_ATTEMPTS} attempts (${message}), stopping run`)
          fatal = true
          break
        }
        const retryDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
        logger.warn(
          `batch ${batchNum}/${totalBatches}: Gemini request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying in ${retryDelay}ms`,
        )
        await delay(retryDelay)
      }
    }
    if (fatal) break

    if (!Array.isArray(raw)) {
      logger.error(`batch ${batchNum}/${totalBatches}: unexpected response shape (not an array), skipping batch`)
      processedSoFar += batch.length
      logProgress(logger, processedSoFar, candidates.length)
      continue
    }

    const assignments: { id: string; productId: number }[] = []
    let skipped = 0

    for (const item of raw as { id?: unknown; base_model?: unknown; variant?: unknown; category?: unknown }[]) {
      if (typeof item.id !== 'string' || typeof item.base_model !== 'string') {
        skipped += 1
        continue
      }
      const candidate = batch.find((c) => c.id === item.id)
      if (!candidate) {
        skipped += 1
        continue
      }

      const variant = typeof item.variant === 'string' && item.variant.trim() !== '' ? item.variant : null
      // Dashboard browsing/filtering aid only - a missing/invalid category
      // falls back to null rather than skipping the whole item, since
      // base_model assignment matters far more than category.
      const category =
        typeof item.category === 'string' && (PRODUCT_CATEGORIES as readonly string[]).includes(item.category)
          ? item.category
          : null
      // Canonicalize known aliases (e.g. "PS5" -> "PlayStation 5") before the
      // lookup, so a listing extracted with an alias resolves to the same
      // product_id as one extracted with the canonical form - no duplicate
      // product row ever gets created for aliases already on this list. Only
      // catches known aliases; a brand-new one extraction turns up still
      // needs a human to spot it and add an entry (same gap as
      // flag-price-ineligible's curated list) - merge-duplicate-products.ts
      // remains the manual retroactive fix for whatever slips through.
      const baseModel = CANONICAL_BASE_MODEL[item.base_model] ?? item.base_model
      const cacheKey = `${normalizeBaseModel(baseModel)}::${variant ? normalizeVariantTier(variant) : ''}`
      let productId = productIdCache.get(cacheKey)
      if (productId === undefined) {
        productId = await findOrCreateProduct(db, baseModel, variant, category)
        productIdCache.set(cacheKey, productId)
      }

      assignments.push({ id: item.id, productId })
      logger.info(`listing ${item.id} -> product ${productId} (${baseModel}${variant ? `, ${variant}` : ''})`)
    }

    await updateListingProductIds(db, assignments)

    processedSoFar += batch.length
    logger.info(
      `batch ${batchNum}/${totalBatches} done: ${assignments.length} assigned, ${skipped} skipped, ` +
        `${productIdCache.size} distinct products seen so far`,
    )
    logProgress(logger, processedSoFar, candidates.length)
  }
}

function logProgress(logger: Logger, processedSoFar: number, pendingTotal: number): void {
  const pct = pendingTotal === 0 ? 100 : Math.round((processedSoFar / pendingTotal) * 100)
  logger.info(`${processedSoFar}/${pendingTotal} pending processed (${pct}%)`)
}

async function main() {
  loadEnvFile()
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product extraction requires Postgres')

  const logger = createLogger('data/extract-products.log')

  // Free tier is 20 requests/day per project per model — a second key from a
  // different Google account is a different project, so it has its own
  // independent quota. Falls back to it automatically on a 429, rather than
  // needing to guess in advance how many requests either one has left today.
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
      const candidates = await getExtractionCandidates(pool)
      await runProductExtraction(gemini, pool, logger, candidates, {
        // Free tier is 20 requests/DAY for gemini-2.5-flash (confirmed live 2026-08-20
        // via a real 429 — NOT the ~1,500/day figure researched earlier, which turned
        // out to be the separate Google Search grounding quota, not base generateContent).
        batchSize: 100,
        delayMs: 5000,
      })
      logger.info(`lap ${lap} complete, sleeping ${LOOP_DELAY_MS}ms`)
      lap++
      await realDelay(LOOP_DELAY_MS)
    }
  } finally {
    await pool.end()
  }
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
