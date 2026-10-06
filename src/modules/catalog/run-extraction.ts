import type { Logger } from '../../platform/logger'
import type { GeminiClient, GroqClient, ExaClient, TavilyClient, RetryOptions } from '../../platform/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type {
  DiscountNotification,
  DiscountPolicyThresholds,
  PriceLookupClients,
  ProductPricingResult,
} from '../pricing'
import {
  decideListingDiscount,
  DEFAULT_DISCOUNT_POLICY,
  ensureProductPriced,
  getProductPricingStatus,
  insertDiscountNotifications,
  PriceLookupFailedError,
} from '../pricing'
import type { ExtractionCandidate } from './product-storage'
import { findOrCreateProduct, updateListingProductIds } from './product-storage'
import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA } from './products'
import type { ExtractedListing } from './extraction'
import { parseExtractionItem } from './extraction'

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
// run-enrichment.ts's 3s) because "usually temporary" for a model-capacity
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

const DEFAULT_INTER_BATCH_DELAY_MS = 5000

interface ExtractionIo {
  clients: ExtractionClients
  db: DbClient
  logger: Logger
  delay?: DelayFn
}

// State shared by every batch of one run.
interface ExtractionRun {
  db: DbClient
  logger: Logger
  priceLookupClients: PriceLookupClients
  discountThresholds: DiscountPolicyThresholds
  // Caches base_model -> product_id across the whole run (not just one batch) — many
  // listings share a base_model, and each cache hit avoids a real Postgres round trip.
  productIds: Map<string, number>
  // Caches pricing status per product_id across the whole run too - several
  // listings in the same batch (or across batches) can share a brand-new
  // product; without this, each would redo the same DB check/API calls.
  pricing: Map<number, ProductPricingResult>
}

// Ensures a product has retail/secondhand pricing before its listing's
// discount gets checked - the trigger this whole design runs off (2026-08-31):
// retail pricing becoming available, not "2+ sibling listings exist" (which
// can never fire for a product's first listing). Checks existing status
// first and skips straight through if the product is already priced or
// already excluded - ensureProductPriced always attempts a fresh lookup
// unconditionally, so that check has to happen here, not there.
async function ensureProductPricing(
  { db, logger, priceLookupClients }: ExtractionRun,
  productId: number,
  { baseModel, variant }: ExtractedListing,
): Promise<ProductPricingResult> {
  const status = await getProductPricingStatus(db, productId)
  if (status.excluded || status.retail || status.secondhand) {
    return status
  }
  // description/sibling_variants come back empty for a product this new -
  // it hasn't been through product enrichment yet. The search still works,
  // just with less disambiguating context than a backfilled lookup gets.
  // A quota error propagates and stops the run (batch stays unassigned). A
  // chain that only failed transiently leaves the product unpriced but not
  // excluded: the listing is still assigned and the price-lookup backfill
  // retries the product later.
  try {
    return await ensureProductPriced(
      { clients: priceLookupClients, db, logger },
      { id: productId, base_model: baseModel, variant_tier: variant, description: null, sibling_variants: [] },
    )
  } catch (err) {
    if (!(err instanceof PriceLookupFailedError)) throw err
    logger.warn(`${err.message}, leaving product ${productId} for the price-lookup backfill`)
    return { retail: null, secondhand: null, excluded: false }
  }
}

async function resolveProductId(run: ExtractionRun, listing: ExtractedListing): Promise<number> {
  let productId = run.productIds.get(listing.productKey)
  if (productId === undefined) {
    productId = await findOrCreateProduct(run.db, {
      baseModel: listing.baseModel,
      variantTier: listing.variant,
      category: listing.category,
      subCategory: listing.subCategory,
    })
    run.productIds.set(listing.productKey, productId)
  }
  return productId
}

// Ensures the listing's product has retail/secondhand pricing (fetching only
// if genuinely missing), then decides this listing's own discount against that
// pricing (or peer-comparison, if secondhand isn't in yet) - see
// ensureProductPricing/decideListingDiscount for the full reasoning.
async function decideDiscount(
  run: ExtractionRun,
  productId: number,
  listing: ExtractedListing,
): Promise<DiscountNotification | null> {
  let pricing = run.pricing.get(productId)
  if (pricing === undefined) {
    pricing = await ensureProductPricing(run, productId, listing)
    run.pricing.set(productId, pricing)
  }
  if (pricing.excluded) return null
  const { candidate } = listing
  return decideListingDiscount(
    run.db,
    { id: candidate.id, productId, condition: candidate.condition, priceAmount: candidate.price_amount },
    { retail: pricing.retail, secondhand: pricing.secondhand },
    run.discountThresholds,
  )
}

// Assigns each extracted listing in one batch to its product (one batched
// UPDATE). Discounts are decided before that UPDATE, so the peer median never
// counts the batch's own listings and a failure while pricing/deciding leaves
// the whole batch unassigned for the next run. Notifications are inserted only
// after the UPDATE succeeds, so a failed save leaves none for listings without
// a product_id. Skipped items keep product_id null and stay candidates too.
async function assignBatch(
  run: ExtractionRun,
  batch: ExtractionCandidate[],
  items: unknown[],
): Promise<{ assigned: number; skipped: number }> {
  const assigned: { listing: ExtractedListing; productId: number }[] = []
  const notifications: DiscountNotification[] = []
  let skipped = 0

  for (const item of items) {
    const outcome = parseExtractionItem(item, batch)
    if (outcome.kind === 'malformed') {
      run.logger.warn(`item ${outcome.idHint}: malformed fields in model response, skipping`)
      skipped += 1
      continue
    }
    if (outcome.kind === 'unknown-candidate') {
      run.logger.warn(`item ${outcome.id}: no matching listing in this batch, skipping`)
      skipped += 1
      continue
    }
    const { listing } = outcome
    const productId = await resolveProductId(run, listing)
    assigned.push({ listing, productId })
    run.logger.info(
      `listing ${listing.candidate.id} -> product ${productId} (${listing.baseModel}${listing.variant ? `, ${listing.variant}` : ''})`,
    )
    const notification = await decideDiscount(run, productId, listing)
    if (notification) notifications.push(notification)
  }

  await updateListingProductIds(
    run.db,
    assigned.map(({ listing, productId }) => ({ id: listing.candidate.id, productId })),
  )
  // No transaction on DbClient: a failure between these two statements loses
  // this batch's notifications (listings already assigned, not retried).
  // Accepted 2026-10-06 (BUY-37); the one-statement insert keeps it all or nothing.
  await insertDiscountNotifications(run.db, notifications)
  return { assigned: assigned.length, skipped }
}

// Extracts products from listings in model-sized batches, pacing between
// batches. Stops the run once both providers are exhausted; skips a batch
// whose response has no results array.
export async function runProductExtraction(
  { clients, db, logger, delay = realDelay }: ExtractionIo,
  candidates: ExtractionCandidate[],
  options: ExtractionOptions,
): Promise<void> {
  logger.info(`${candidates.length} listings pending product extraction`)

  const run: ExtractionRun = {
    db,
    logger,
    priceLookupClients: { gemini: clients.gemini, exa: clients.exa, tavily: clients.tavily },
    discountThresholds: options.discountThresholds ?? DEFAULT_DISCOUNT_POLICY,
    productIds: new Map(),
    pricing: new Map(),
  }
  const delayMs = options.delayMs ?? DEFAULT_INTER_BATCH_DELAY_MS
  const retry = {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    backoff: 'exponential' as const,
    delay,
    logger,
  }
  const totalBatches = Math.ceil(candidates.length / options.batchSize)
  let processedSoFar = 0

  for (let i = 0; i < candidates.length; i += options.batchSize) {
    if (i > 0) {
      logger.info(`waiting ${delayMs}ms before next batch`)
      await delay(delayMs)
    }
    const batch = candidates.slice(i, i + options.batchSize)
    const label = `batch ${i / options.batchSize + 1}/${totalBatches}`
    logger.info(`${label}: sending ${batch.length} listings to Groq`)
    const prompt = buildExtractionPrompt(
      batch.map((c) => ({ id: c.id, title: c.title, description: c.description ?? '' })),
    )

    const raw = (await extractBatch(clients, prompt, { ...retry, label })) as { results?: unknown } | null
    if (raw === null) break

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`${label}: unexpected response shape (no results array), skipping batch`)
    } else {
      const { assigned, skipped } = await assignBatch(run, batch, raw.results)
      logger.info(
        `${label} done: ${assigned} assigned, ${skipped} skipped, ` +
          `${run.productIds.size} distinct products seen so far`,
      )
    }
    processedSoFar += batch.length
    logProgress(logger, processedSoFar, candidates.length)
  }
}

function logProgress(logger: Logger, processedSoFar: number, pendingTotal: number): void {
  const pct = pendingTotal === 0 ? 100 : Math.round((processedSoFar / pendingTotal) * 100)
  logger.info(`${processedSoFar}/${pendingTotal} pending processed (${pct}%)`)
}
