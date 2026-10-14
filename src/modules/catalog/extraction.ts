import type { Logger } from '../../platform/logger'
import type { GeminiClient, GroqClient, ExaClient, TavilyClient, RetryOptions } from '../../platform/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type {
  NewDiscountNotification,
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
import type { ExtractionCandidate } from './store/extraction'
import { findOrCreateProduct, updateListingProductIds } from './store/products'
import {
  CANONICAL_BASE_MODEL,
  normalizeBaseModel,
  normalizeVariantTier,
  isProductCategory,
  isSubCategory,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
} from './products'
import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'

export interface ExtractionInput {
  id: string
  title: string
  description: string
}

const DESCRIPTION_TRUNCATE_LENGTH = 150

function formatListingLine(l: ExtractionInput): string {
  const desc = l.description.slice(0, DESCRIPTION_TRUNCATE_LENGTH)
  return `[id: ${l.id}] title: "${l.title}" desc: "${desc}"`
}

export function buildExtractionPrompt(listings: ExtractionInput[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  return `Extract the base product model from each Facebook Marketplace listing below.
Return ONLY the core product line/model - strip seller phrases ("RUSH", "FOR SALE"),
condition, price, storage/color, and edition/variant details (write "RTX 3060" not
"RTX 3060 OC Asus"; write "iPhone 13" not "iPhone 13 128GB Blue"). If genuinely
unidentifiable even from the description, use a general category instead ("Laptop",
"Bicycle") rather than guessing wrong.

Also extract a "variant" for each listing ONLY when the title/description clearly
signals a specific edition/trim that plausibly affects its value (e.g. "Founders
Edition", "Custom AIB/OC", "Pro", "Max"). Leave variant as an empty string ""
when no such signal is present - do NOT use storage capacity or color as a variant.

If the base model name itself ends in a known trim/tier word, move that word into
variant instead of leaving it in base_model - the same product must always produce
the same base_model regardless of which trim was in the listing title. For example:
- "iPhone 14 Plus" -> base_model: "iPhone 14", variant: "Plus"
- "iPad 9th Gen" / "iPad 9th Generation" -> base_model: "iPad", variant: "9th Gen"
- "MacBook Air M2" -> base_model: "MacBook Air", variant: "M2"
- "Galaxy S23 Ultra" -> base_model: "Samsung Galaxy S23", variant: "Ultra"
Never repeat the same trim word in both base_model and variant.

Only record a network band ("5G"/"4G") as variant when the same base model is
genuinely sold in more than one band - if every listing you've seen for that model
is 5G, leave variant empty rather than tagging every one of them "5G".

Also assign a "category" for each listing - exactly one of: ${PRODUCT_CATEGORIES.join(', ')}.
Use "Other" if none genuinely fit rather than forcing a bad match.

Also assign a finer "sub_category" for each listing - exactly one of: ${SUB_CATEGORIES.join(', ')}.
Pick whichever fits best regardless of which "category" you chose above (e.g. a listing you put
under "Computers & Laptops" might still be "Graphics Cards" or "Consoles" if that's a better fit -
the two fields are judged independently). Use "Other" if none genuinely fit.

Listings:
${lines}`
}

// Root type must be 'object', not 'array' - confirmed live 2026-09-03 via a
// direct call: Groq hard-rejects any response_format schema whose top level
// isn't 'object' ("schema must have type 'object' and not have
// 'oneOf'/'anyOf'/'enum'/'not' at the top level"), on every model, not just
// a specific one - this had silently been failing every single Groq call
// and falling through to Gemini instead. Wrapped in the same {results: [...]}
// envelope every other schema in this file already uses; variant is nullable
// rather than omitted from `required`, since strict mode requires every
// property be listed there.
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          base_model: { type: 'string' },
          variant: { type: ['string', 'null'] },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
          sub_category: { type: 'string', enum: SUB_CATEGORIES },
        },
        required: ['id', 'base_model', 'variant', 'category', 'sub_category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

// Same key shape as ExtractedListing.productKey, so an alias and its rule
// match on normalized text exactly as findProduct does when the merge script
// applies these rules after the fact.
function productKeyOf(baseModel: string, variant: string | null): string {
  return `${normalizeBaseModel(baseModel)}::${variant ? normalizeVariantTier(variant) : ''}`
}

// Built once at import: 318 rules, a plain Map, no I/O.
const ALIAS_RULE_BY_KEY = new Map(
  PRODUCT_VARIANT_ALIAS_RULES.map((rule) => [productKeyOf(rule.aliasBase, rule.aliasVariant), rule]),
)

// Fields of one item of the model's `results` array, unvalidated.
interface RawExtractionItem {
  id?: unknown
  base_model?: unknown
  variant?: unknown
  category?: unknown
  sub_category?: unknown
}

export interface ExtractedListing {
  candidate: ExtractionCandidate
  baseModel: string
  variant: string | null
  category: string | null
  subCategory: string | null
  // Listings with the same key belong to the same product row.
  productKey: string
}

type ExtractionItemOutcome =
  | { kind: 'malformed'; idHint: string }
  | { kind: 'unknown-candidate'; id: string }
  | { kind: 'extracted'; listing: ExtractedListing }

// Validates one response item against the batch it answers. Any value is
// accepted (the model can return null or non-object entries) and reported as
// malformed rather than thrown, same shape as parseEnrichmentItem.
export function parseExtractionItem(raw: unknown, batch: ExtractionCandidate[]): ExtractionItemOutcome {
  const item: RawExtractionItem = typeof raw === 'object' && raw !== null ? raw : {}
  if (typeof item.id !== 'string' || typeof item.base_model !== 'string') {
    return { kind: 'malformed', idHint: typeof item.id === 'string' ? item.id : '(missing/invalid id)' }
  }
  const candidate = batch.find((c) => c.id === item.id)
  if (!candidate) return { kind: 'unknown-candidate', id: item.id }

  const variant = typeof item.variant === 'string' && item.variant.trim() !== '' ? item.variant : null
  // Canonicalize known aliases (e.g. "PS5" -> "PlayStation 5") before the
  // lookup, so a listing extracted with an alias resolves to the same
  // product_id as one extracted with the canonical form - no duplicate
  // product row ever gets created for aliases already on this list. Only
  // catches known aliases; a brand-new one extraction turns up still
  // needs a human to spot it and add an entry (same gap as
  // pricing's ineligible-categories.ts curated list) - merge.ts
  // remains the manual retroactive fix for whatever slips through.
  const mappedBaseModel = CANONICAL_BASE_MODEL[item.base_model] ?? item.base_model
  // Base+variant aliases too (BUY-59): found live 2026-10-08, 24 of these
  // rules matched products extraction had created again after the 2026-09-02
  // merge, because only the manual merge script applied them.
  const aliasRule = ALIAS_RULE_BY_KEY.get(productKeyOf(mappedBaseModel, variant))
  const baseModel = aliasRule ? aliasRule.canonicalBase : mappedBaseModel
  const resolvedVariant = aliasRule ? aliasRule.canonicalVariant : variant
  return {
    kind: 'extracted',
    listing: {
      candidate,
      baseModel,
      variant: resolvedVariant,
      // Dashboard browsing/filtering aid only - a missing/invalid category
      // falls back to null rather than skipping the whole item, since
      // base_model assignment matters far more than category.
      category: isProductCategory(item.category) ? item.category : null,
      subCategory: isSubCategory(item.sub_category) ? item.sub_category : null,
      productKey: productKeyOf(baseModel, resolvedVariant),
    },
  }
}

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
// enrichment.ts's 3s) because "usually temporary" for a model-capacity
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
): Promise<NewDiscountNotification | null> {
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
  const notifications: NewDiscountNotification[] = []
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
