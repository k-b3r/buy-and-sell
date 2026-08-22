import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient, createFallbackGeminiClient } from './gemini'
import type { DbClient, ExtractionCandidate } from './db'
import { createDbPool, findOrCreateProduct, updateListingProductIds, getExtractionCandidates } from './db'
import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA, normalizeBaseModel, normalizeVariantTier } from './products'

export interface ExtractionOptions {
  batchSize: number
  delayMs?: number
}

export type DelayFn = (ms: number) => Promise<void>

const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    const raw = await gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)

    if (!Array.isArray(raw)) {
      logger.error(`batch ${batchNum}/${totalBatches}: unexpected response shape (not an array), skipping batch`)
      processedSoFar += batch.length
      logProgress(logger, processedSoFar, candidates.length)
      continue
    }

    const assignments: { id: string; productId: number }[] = []
    let skipped = 0

    for (const item of raw as { id?: unknown; base_model?: unknown; variant?: unknown }[]) {
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
      const cacheKey = `${normalizeBaseModel(item.base_model)}::${variant ? normalizeVariantTier(variant) : ''}`
      let productId = productIdCache.get(cacheKey)
      if (productId === undefined) {
        productId = await findOrCreateProduct(db, item.base_model, variant)
        productIdCache.set(cacheKey, productId)
      }

      assignments.push({ id: item.id, productId })
      logger.info(`listing ${item.id} -> product ${productId} (${item.base_model}${variant ? `, ${variant}` : ''})`)
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
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
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

  try {
    const candidates = await getExtractionCandidates(pool)
    await runProductExtraction(gemini, pool, logger, candidates, {
      // Free tier is 20 requests/DAY for gemini-2.5-flash (confirmed live 2026-08-20
      // via a real 429 — NOT the ~1,500/day figure researched earlier, which turned
      // out to be the separate Google Search grounding quota, not base generateContent).
      batchSize: 100,
      delayMs: 5000,
    })
  } finally {
    await pool.end()
  }
  logger.info('product extraction complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
