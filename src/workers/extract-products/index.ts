import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GeminiClient, GroqClient, ExaClient, TavilyClient } from '../../domains/llm-clients'
import {
  createGeminiClient,
  createFallbackGeminiClient,
  isGeminiQuotaError,
  createGroqClient,
  createFallbackGroqClient,
  isGroqQuotaError,
  createExaClient,
  createFallbackExaClient,
  loadExaApiKeys,
  createTavilyClient,
} from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { ExtractionCandidate } from '../../domains/marketplace/storage/products'
import { findOrCreateProduct, updateListingProductIds, getExtractionCandidates } from '../../domains/marketplace/storage/products'
import { checkListingDiscount } from '../../domains/marketplace/storage/listings'
import { getProductPricingStatus } from '../../domains/marketplace/storage/pricing'
import type { PriceLookupClients, ProductPricingResult } from '../../domains/marketplace'
import { ensureProductPriced } from '../../domains/marketplace'
import {
  buildExtractionPrompt,
  EXTRACTION_RESPONSE_SCHEMA,
  normalizeBaseModel,
  normalizeVariantTier,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
  CANONICAL_BASE_MODEL,
} from '../../domains/marketplace'

export interface ExtractionClients {
  groq: GroqClient
  // Also doubles as PriceLookupClients' gemini role (generateGroundedText,
  // secondhand pricing) - one client, two call shapes, no reason for a
  // second instance.
  gemini: GeminiClient
  exa: ExaClient
  tavily: TavilyClient
}

export interface ExtractionOptions {
  batchSize: number
  delayMs?: number
}

// Groq is primary now (no daily-request quota surprise like Gemini's, and
// doesn't compete with price-lookup.ts's secondhand chain for Gemini's
// tight, live-confirmed ~20 req/day/key budget) - Gemini is a pure fallback,
// tried only once Groq is exhausted. Gemini's free tier throws real 503s
// under load ("This model is currently experiencing high demand... usually
// temporary") — confirmed live 2026-08-24 on Hetzner, which crashed the
// whole run uncaught. Exponential backoff starting at 30s (not
// enrich-products.ts's 3s) because "usually temporary" for a model-capacity
// spike plausibly means minutes, not seconds — 5 attempts caps the wait at
// 30+60+120+240 = ~7.5 minutes before giving up. A real quota error (429,
// all fallback keys exhausted) is not retried on that same provider —
// retrying can't fix an exhausted quota — but does fall through to the
// other provider's own retry loop rather than failing the batch outright.
const MAX_ATTEMPTS = 5
const RETRY_BASE_DELAY_MS = 30000

// Runs forever, not once - re-queries getExtractionCandidates every lap so
// newly-collected listings (collect.ts adds more over time) get picked up
// without a restart, same pattern as enrich-products.ts.
const LOOP_DELAY_MS = 300000

// Tries Groq first (own retry/backoff loop below), and only on quota
// exhaustion or exhausted retries falls through to a second retry loop
// against Gemini - not fatal until BOTH providers are exhausted. Returns
// null only when neither provider produced a response.
async function extractBatch(
  clients: ExtractionClients,
  prompt: string,
  logger: Logger,
  batchLabel: string,
  delay: DelayFn,
): Promise<unknown | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await clients.groq.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isGroqQuotaError(err)) {
        logger.warn(`${batchLabel}: Groq quota exhausted (${message}), falling back to Gemini`)
        break
      }
      if (attempt === MAX_ATTEMPTS) {
        logger.warn(`${batchLabel}: Groq request failed after ${MAX_ATTEMPTS} attempts (${message}), falling back to Gemini`)
        break
      }
      const retryDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      logger.warn(`${batchLabel}: Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying in ${retryDelay}ms`)
      await delay(retryDelay)
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await clients.gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isGeminiQuotaError(err)) {
        logger.error(`${batchLabel}: Gemini quota exhausted across all configured keys too (${message}), stopping run`)
        return null
      }
      if (attempt === MAX_ATTEMPTS) {
        logger.error(`${batchLabel}: Gemini request failed after ${MAX_ATTEMPTS} attempts too (${message}), stopping run`)
        return null
      }
      const retryDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      logger.warn(`${batchLabel}: Gemini request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying in ${retryDelay}ms`)
      await delay(retryDelay)
    }
  }
  return null
}

// Ensures a product has retail/secondhand pricing before its listing's
// discount gets checked - the trigger this whole design runs off (2026-08-31):
// retail pricing becoming available, not "2+ sibling listings exist" (which
// can never fire for a product's first listing). Checks existing status
// first and skips straight through if the product is already priced or
// already excluded - ensureProductPriced always attempts a fresh lookup
// unconditionally, so that check has to happen here, not there.
async function ensureProductPricing(
  clients: PriceLookupClients,
  db: DbClient,
  productId: number,
  baseModel: string,
  variantTier: string | null,
  logger: Logger,
): Promise<ProductPricingResult> {
  const status = await getProductPricingStatus(db, productId)
  if (status.excluded || status.retail || status.secondhand) {
    return status
  }
  // description/sibling_variants come back empty for a product this new -
  // it hasn't been through enrich-products.ts yet. The search still works,
  // just with less disambiguating context than a backfilled lookup gets.
  return ensureProductPriced(clients, db, { id: productId, base_model: baseModel, variant_tier: variantTier, description: null, sibling_variants: [] }, logger)
}

export async function runProductExtraction(
  clients: ExtractionClients,
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
  // Caches pricing status per product_id across the whole run too - several
  // listings in the same batch (or across batches) can share a brand-new
  // product; without this, each would redo the same DB check/API calls.
  const pricingCache = new Map<number, ProductPricingResult>()
  const priceLookupClients: PriceLookupClients = { gemini: clients.gemini, exa: clients.exa, tavily: clients.tavily }
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
    const batchLabel = `batch ${batchNum}/${totalBatches}`
    logger.info(`${batchLabel}: sending ${batch.length} listings to Groq`)
    const prompt = buildExtractionPrompt(batch.map((c) => ({ id: c.id, title: c.title, description: c.description ?? '' })))

    const raw = await extractBatch(clients, prompt, logger, batchLabel, delay)
    if (raw === null) break

    if (!Array.isArray(raw)) {
      logger.error(`batch ${batchNum}/${totalBatches}: unexpected response shape (not an array), skipping batch`)
      processedSoFar += batch.length
      logProgress(logger, processedSoFar, candidates.length)
      continue
    }

    const assignments: { id: string; productId: number }[] = []
    let skipped = 0

    for (const item of raw as {
      id?: unknown
      base_model?: unknown
      variant?: unknown
      category?: unknown
      sub_category?: unknown
    }[]) {
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
      const subCategory =
        typeof item.sub_category === 'string' && (SUB_CATEGORIES as readonly string[]).includes(item.sub_category)
          ? item.sub_category
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
        productId = await findOrCreateProduct(db, baseModel, variant, category, subCategory)
        productIdCache.set(cacheKey, productId)
      }

      assignments.push({ id: item.id, productId })
      logger.info(`listing ${item.id} -> product ${productId} (${baseModel}${variant ? `, ${variant}` : ''})`)

      // Before saving this item: ensure its product has retail/secondhand
      // pricing (fetching only if genuinely missing), then check this
      // listing's own discount against that pricing (or peer-comparison,
      // if secondhand isn't in yet) - see ensureProductPricing/
      // checkListingDiscount for the full reasoning.
      let pricing = pricingCache.get(productId)
      if (pricing === undefined) {
        pricing = await ensureProductPricing(priceLookupClients, db, productId, baseModel, variant, logger)
        pricingCache.set(productId, pricing)
      }
      if (!pricing.excluded) {
        await checkListingDiscount(db, item.id, productId, candidate.condition, candidate.price_amount, pricing.retail, pricing.secondhand)
      }
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

const MODEL = 'openai/gpt-oss-120b'

async function main() {
  loadEnvFile()
  const groqApiKey = process.env.FREE_GROQ_API_KEY
  if (!groqApiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const exaApiKeys = loadExaApiKeys()
  if (exaApiKeys.length === 0) throw new Error('No EXA_API_KEY<n> (EXA_API_KEY0, EXA_API_KEY1, ...) set in .env')
  const tavilyApiKey = process.env.TAVILY_API_KEY
  if (!tavilyApiKey) throw new Error('TAVILY_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product extraction requires Postgres')

  const logger = createLogger('data/extract-products.log')
  writePidFile('data/extract-products.pid')

  // Same multi-key/multi-model fallback shape as enrich-products.ts - a
  // second model on the same key first (cheap, no new credential needed),
  // then a second key's own pair if configured.
  const groqClients = [createGroqClient(groqApiKey, MODEL), createGroqClient(groqApiKey, 'openai/gpt-oss-20b')]
  const altGroqApiKey = process.env.ALT_FREE_GROQ_API_KEY
  if (altGroqApiKey) {
    groqClients.push(createGroqClient(altGroqApiKey, MODEL), createGroqClient(altGroqApiKey, 'openai/gpt-oss-20b'))
    logger.info('ALT_FREE_GROQ_API_KEY configured, will fall back to it once the primary key is exhausted')
  }
  const groq = createFallbackGroqClient(groqClients)

  // Free tier is 20 requests/day per project per model — a second key from a
  // different Google account is a different project, so it has its own
  // independent quota. Gemini is now the fallback provider (see MAX_ATTEMPTS'
  // comment above), tried only once Groq is exhausted.
  const altGeminiApiKey = process.env.ALT_FREE_GEMINI_API_KEY
  const gemini = altGeminiApiKey
    ? createFallbackGeminiClient([createGeminiClient(geminiApiKey), createGeminiClient(altGeminiApiKey, 'gemini-3.6-flash')])
    : createGeminiClient(geminiApiKey)
  if (altGeminiApiKey) {
    logger.info('ALT_FREE_GEMINI_API_KEY configured, will fall back to it (gemini-3.6-flash) on quota exhaustion')
  }
  // Exa is now the primary source for both retail and secondhand pricing
  // (see domains/marketplace/price-lookup.ts) - its credits ran out
  // mid-investigation once already (2026-08-31, real 402), so multiple keys
  // are worth having on hand here too (see loadExaApiKeys).
  logger.info(`${exaApiKeys.length} Exa API key(s) configured`)
  const exa = createFallbackExaClient(exaApiKeys.map(createExaClient))
  const tavily = createTavilyClient(tavilyApiKey)

  const clients: ExtractionClients = { groq, gemini, exa, tavily }
  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getExtractionCandidates(pool)
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Groq for extraction on ${candidates.length} listings this lap`)
      } else {
        await runProductExtraction(clients, pool, logger, candidates, {
          // batchSize was tuned around Gemini's 20 req/day cap (confirmed
          // live 2026-08-20) - unverified whether 100/batch is still the
          // right size now that Groq (TPM-capped, not daily-request-capped)
          // is primary. Left as-is pending a live batch-size audit, same
          // status as enrich-listing-prices.ts's 35 and
          // backfill-categories.ts's 100 (see pipeline-consolidation plan).
          batchSize: 100,
          delayMs: 5000,
        })
      }
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
