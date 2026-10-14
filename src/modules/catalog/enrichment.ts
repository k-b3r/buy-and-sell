import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../platform/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { isProductCategory, PRODUCT_CATEGORIES } from './products'
import type { EnrichmentCandidate, EnrichmentData } from './store/enrichment'
import { upsertProductEnrichment } from './store/enrichment'
import { updateProductCategories } from './store/products'

function formatProductLine(p: EnrichmentCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  const siblings =
    p.sibling_variants.length > 0
      ? ` — other tracked variants of this base model: ${p.sibling_variants.join(', ')}`
      : ''
  return `[id: ${p.id}] ${label}${siblings}`
}

export function buildEnrichmentPrompt(products: EnrichmentCandidate[]): string {
  const lines = products.map(formatProductLine).join('\n')
  return `For each product below (identified by base model / variant) that you actually
recognize, provide:
- description: a concise description of what this product is (2-3 sentences)
- value_drivers: what affects this specific product's resale value - condition
  factors, common defects/wear points, meaningful spec or variant differences, what
  separates a well-priced unit from an overpriced one. Where "other tracked variants"
  are listed, write value_drivers specific to THIS variant, not the whole family -
  say how it differs from those siblings where that's relevant to value, not a
  generic description that could apply to any of them.
- has_trained_price_knowledge: true only if you have specific knowledge of this
  product's typical secondhand price from your training data, not a generic guess
- trained_price_low / trained_price_high: if has_trained_price_knowledge is true,
  your best estimate of the typical secondhand price range in PHP (Philippines) as
  of your training data; null otherwise
- category: exactly one of: ${PRODUCT_CATEGORIES.join(', ')}. Use "Other" if none
  genuinely fit rather than forcing a bad match.
- is_specific_product: true only if this base model names one real, specific,
  priceable product (a model/SKU/nameplate) - not a generic category noun like
  "Furniture" or "Motherboard", and not a bare brand with no model like
  "Lenovo Thinkpad" (real prices for that span too wide a range to mean
  anything as one product), even if you recognize the words.
- confidence: "high" if you're sure of your is_specific_product judgment,
  "low" if this could plausibly be outside your training knowledge either way
  (a genuinely new or obscure product) - don't force a confident guess.

Do not search - answer only from what you already know. If you do not recognize a
product at all (the name doesn't correspond to anything you actually know), omit it from the results array entirely - do not fabricate a description for a
product you don't actually know. If you recognize the product itself but have no
confident price knowledge, still include it, with has_trained_price_knowledge set
to false and the price fields null.

Products:
${lines}`
}

export const ENRICHMENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          value_drivers: { type: 'string' },
          has_trained_price_knowledge: { type: 'boolean' },
          trained_price_low: { type: ['number', 'null'] },
          trained_price_high: { type: ['number', 'null'] },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
          is_specific_product: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: [
          'id',
          'description',
          'value_drivers',
          'has_trained_price_knowledge',
          'trained_price_low',
          'trained_price_high',
          'category',
          'is_specific_product',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

// Fields of one item of the model's `results` array, unvalidated.
interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
  category?: unknown
  is_specific_product?: unknown
  confidence?: unknown
}

// What happens to the product's category once its enrichment is saved:
// 'keep' when it already has one, 'invalid' when it has none and the
// response's category isn't a valid one.
type CategoryDecision = { kind: 'keep' } | { kind: 'assign'; category: string } | { kind: 'invalid' }

type EnrichmentItemOutcome =
  | { kind: 'malformed'; idHint: string }
  | { kind: 'unknown-candidate'; id: string }
  | { kind: 'enriched'; candidate: EnrichmentCandidate; data: EnrichmentData; category: CategoryDecision }

// Validates one response item against the batch it answers. Category is
// best-effort, unlike the enrichment fields: a malformed category doesn't
// invalidate the enrichment itself. It only ever fills a gap: a candidate
// that already has a category (assigned at creation by product extraction)
// keeps it as-is. Any value is accepted (the model can return null or
// non-object entries) and reported as malformed rather than thrown.
export function parseEnrichmentItem(raw: unknown, batch: EnrichmentCandidate[]): EnrichmentItemOutcome {
  const item: RawEnrichmentItem = typeof raw === 'object' && raw !== null ? raw : {}
  if (
    typeof item.id !== 'string' ||
    typeof item.description !== 'string' ||
    typeof item.value_drivers !== 'string' ||
    typeof item.has_trained_price_knowledge !== 'boolean' ||
    typeof item.is_specific_product !== 'boolean' ||
    (item.confidence !== 'high' && item.confidence !== 'low')
  ) {
    return { kind: 'malformed', idHint: typeof item.id === 'string' ? item.id : '(missing/invalid id)' }
  }
  const id = item.id
  const candidate = batch.find((c) => String(c.id) === id)
  if (!candidate) return { kind: 'unknown-candidate', id }

  const data: EnrichmentData = {
    description: item.description,
    valueDrivers: item.value_drivers,
    hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
    trainedPriceLow: typeof item.trained_price_low === 'number' ? item.trained_price_low : null,
    trainedPriceHigh: typeof item.trained_price_high === 'number' ? item.trained_price_high : null,
    isSpecificProduct: item.is_specific_product,
    confidence: item.confidence,
  }
  return { kind: 'enriched', candidate, data, category: decideCategory(candidate, item.category) }
}

function decideCategory(candidate: EnrichmentCandidate, category: unknown): CategoryDecision {
  if (candidate.category !== null) return { kind: 'keep' }
  if (isProductCategory(category)) return { kind: 'assign', category }
  return { kind: 'invalid' }
}

// Originally sized at 35 from output-token math alone — wrong, because
// gpt-oss-120b is a reasoning model: it spends hidden "thinking" tokens before
// the JSON, which don't show up in a token-per-field estimate and vary
// non-deterministically run to run. Confirmed live (2026-08-22) against the
// real first batch of pending candidates: n=20 succeeds cleanly (well under
// Groq's 8,000 TPM cap even with reasoning overhead), n=25/30 pass but butt
// up against an apparent ~3,072-token completion ceiling, n=35 fails outright
// with an unhelpful "Failed to validate JSON" 400 (truncated mid-generation,
// not a real schema problem — Groq's error message doesn't say so).
//
// The response schema later grew a `category` field (short enum string, ~1-2
// tokens) — not re-verified live against this ceiling with the extra field.
// Watch the first real run for the same truncation failure mode before
// trusting 20 still holds.
const DEFAULT_BATCH_SIZE = 20
const MODEL = 'openai/gpt-oss-120b'

// gpt-oss-120b occasionally (non-deterministically) wraps the array as
// {"results":{"items":[...]}} instead of {"results":[...]} — confirmed live
// (2026-08-22): replaying the exact same failing batch, attempt 1 and 2
// succeeded, attempt 3 failed this way. Worth a few retries. A real 429 quota
// error is different — retrying just burns more of an already-exhausted
// budget for nothing, so it's excluded and fails on the first hit.
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 3000

interface EnrichmentIo {
  groq: GroqClient
  db: DbClient
  logger: Logger
  delay?: DelayFn
}

interface EnrichmentOptions {
  batchSize?: number
  maxAttempts?: number
  retryDelayMs?: number
}

type EnrichmentResponse = { stop: true } | { stop: false; raw: { results?: unknown } | undefined }

// Asks Groq for one batch's enrichment, retrying transient failures. Groq's
// daily token cap (see spec's Open Risks) is expected to be hit mid-run on
// the full backlog, and a truncated/malformed response can throw a JSON parse
// error inside generateJson too — either way this must be a recorded, clean
// stop, not an uncaught throw that silently truncates the log and kills the
// process (same "don't let this class of error crash uncaught" precedent used
// elsewhere for a batch/quota failure).
async function requestEnrichment(
  { groq, logger, delay = realDelay }: EnrichmentIo,
  prompt: string,
  label: string,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS }: EnrichmentOptions,
): Promise<EnrichmentResponse> {
  try {
    const raw = (await withRetry(() => groq.generateJson(prompt, ENRICHMENT_RESPONSE_SCHEMA), {
      provider: 'Groq',
      label,
      maxAttempts,
      retryDelayMs,
      delay,
      logger,
    })) as { results?: unknown } | undefined
    return { stop: false, raw }
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      logger.error(`${label}: Groq quota exhausted (${err.message}), stopping run`)
    } else if (err instanceof RetriesExhaustedError) {
      logger.error(`${label}: Groq request failed after ${maxAttempts} attempts (${err.message}), stopping run`)
    } else {
      throw err
    }
    return { stop: true }
  }
}

async function saveEnrichments(
  { db, logger }: EnrichmentIo,
  batch: EnrichmentCandidate[],
  items: unknown[],
): Promise<void> {
  const categoryAssignments: { id: number; category: string }[] = []

  for (const item of items) {
    const outcome = parseEnrichmentItem(item, batch)
    if (outcome.kind === 'malformed') {
      logger.warn(`item ${outcome.idHint}: malformed fields in Groq response, skipping`)
      continue
    }
    if (outcome.kind === 'unknown-candidate') {
      logger.warn(`item ${outcome.id}: no matching candidate in this batch, skipping`)
      continue
    }

    const { candidate, data, category } = outcome
    await upsertProductEnrichment(db, candidate.id, data, MODEL)
    logger.info(
      `product ${candidate.id} enriched (trained price known: ${data.hasTrainedPriceKnowledge}, specific product: ${data.isSpecificProduct}/${data.confidence})`,
    )
    if (category.kind === 'assign') {
      categoryAssignments.push({ id: candidate.id, category: category.category })
    } else if (category.kind === 'invalid') {
      logger.warn(`product ${candidate.id}: malformed/invalid category in Groq response, leaving category unset`)
    }
  }

  await updateProductCategories(db, categoryAssignments)
}

// Enriches products in Groq-sized batches. Stops the run when Groq is
// exhausted; skips a batch whose response has no results array.
export async function runProductEnrichment(
  io: EnrichmentIo,
  candidates: EnrichmentCandidate[],
  options: EnrichmentOptions = {},
): Promise<void> {
  const { batchSize = DEFAULT_BATCH_SIZE } = options
  io.logger.info(`${candidates.length} products to enrich`)

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const label = `batch starting at ${i}`
    const response = await requestEnrichment(io, buildEnrichmentPrompt(batch), label, options)
    if (response.stop) break

    const { raw } = response
    if (!raw || !Array.isArray(raw.results)) {
      io.logger.error(`${label}: unexpected response shape (no results array), skipping batch`)
      continue
    }
    await saveEnrichments(io, batch, raw.results)
  }
}
