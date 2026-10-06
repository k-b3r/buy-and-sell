import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../platform/llm-clients'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA, parseEnrichmentItem } from './enrichment'
import type { EnrichmentCandidate } from './enrichment'
import { upsertProductEnrichment, updateProductCategories } from './product-storage'

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
