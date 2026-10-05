import type { Logger } from '../../platform/logger'
import type { GeminiClient, GroqClient, ExaClient, TavilyClient, RetryOptions } from '../../domains/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type { DiscountPolicyThresholds, PriceLookupClients, ProductPricingResult } from '../pricing'
import { checkListingDiscount, DEFAULT_DISCOUNT_POLICY, ensureProductPriced, getProductPricingStatus } from '../pricing'
import type { ExtractionCandidate } from './product-storage'
import { findOrCreateProduct, updateListingProductIds } from './product-storage'
import {
  buildExtractionPrompt,
  EXTRACTION_RESPONSE_SCHEMA,
  normalizeBaseModel,
  normalizeVariantTier,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
  CANONICAL_BASE_MODEL,
} from './products'

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
  maxAttempts?: number
  retryBaseDelayMs?: number
  discountThresholds?: DiscountPolicyThresholds
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
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_BASE_DELAY_MS = 30000

// Tries Groq first (own bounded retry with exponential backoff), and only on
// quota exhaustion or exhausted retries falls through to a second retry run
// against Gemini - not fatal until BOTH providers are exhausted. Returns
// null only when neither provider produced a response.
async function extractBatch(
  clients: ExtractionClients,
  prompt: string,
  retry: Omit<RetryOptions, 'provider'> & { label: string },
): Promise<unknown | null> {
  const { label, logger, maxAttempts } = retry
  try {
    return await withRetry(() => clients.groq.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA), {
      ...retry,
      provider: 'Groq',
    })
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      logger.warn(`${label}: Groq quota exhausted (${err.message}), falling back to Gemini`)
    } else if (err instanceof RetriesExhaustedError) {
      logger.warn(
        `${label}: Groq request failed after ${maxAttempts} attempts (${err.message}), falling back to Gemini`,
      )
    } else {
      throw err
    }
  }

  try {
    return await withRetry(() => clients.gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA), {
      ...retry,
      provider: 'Gemini',
    })
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      logger.error(`${label}: Gemini quota exhausted across all configured keys too (${err.message}), stopping run`)
    } else if (err instanceof RetriesExhaustedError) {
      logger.error(`${label}: Gemini request failed after ${maxAttempts} attempts too (${err.message}), stopping run`)
    } else {
      throw err
    }
    return null
  }
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
  return ensureProductPriced(
    { clients, db, logger },
    { id: productId, base_model: baseModel, variant_tier: variantTier, description: null, sibling_variants: [] },
  )
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
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const discountThresholds = options.discountThresholds ?? DEFAULT_DISCOUNT_POLICY
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
    const prompt = buildExtractionPrompt(
      batch.map((c) => ({ id: c.id, title: c.title, description: c.description ?? '' })),
    )

    const raw = (await extractBatch(clients, prompt, {
      label: batchLabel,
      maxAttempts,
      retryDelayMs: retryBaseDelayMs,
      backoff: 'exponential',
      delay,
      logger,
    })) as { results?: unknown } | null
    if (raw === null) break

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch ${batchNum}/${totalBatches}: unexpected response shape (no results array), skipping batch`)
      processedSoFar += batch.length
      logProgress(logger, processedSoFar, candidates.length)
      continue
    }

    const assignments: { id: string; productId: number }[] = []
    let skipped = 0

    for (const item of raw.results as {
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
        await checkListingDiscount(
          db,
          { id: item.id, productId, condition: candidate.condition, priceAmount: candidate.price_amount },
          { retail: pricing.retail, secondhand: pricing.secondhand },
          discountThresholds,
        )
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
