import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import {
  createGroqPool,
  loadGroqApiKeys,
  QuotaExhaustedError,
  RetriesExhaustedError,
  withRetry,
} from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from '../../domains/marketplace'
import type { EnrichmentCandidate } from '../../domains/marketplace'
import {
  getEnrichmentCandidates,
  upsertProductEnrichment,
  applyEligibilityFromEnrichment,
  updateProductCategories,
} from '../../domains/marketplace'
import { PRODUCT_CATEGORIES } from '../../domains/marketplace'

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

const VALID_CATEGORIES = new Set<string>(PRODUCT_CATEGORIES)

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

export async function runProductEnrichment(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: EnrichmentCandidate[],
  delay: DelayFn = realDelay,
  batchSize = DEFAULT_BATCH_SIZE,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  logger.info(`${candidates.length} products to enrich`)

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const prompt = buildEnrichmentPrompt(batch)

    // Groq's daily token cap (see spec's Open Risks) is expected to be hit mid-run
    // on the full backlog, and a truncated/malformed response can throw a JSON
    // parse error inside generateJson too — either way this must be a recorded,
    // clean stop, not an uncaught throw that silently truncates the log and kills
    // the process (same "don't let this class of error crash uncaught" precedent
    // used elsewhere for a batch/quota failure).
    let raw: { results?: unknown } | undefined
    try {
      raw = (await withRetry(() => groq.generateJson(prompt, ENRICHMENT_RESPONSE_SCHEMA), {
        provider: 'Groq',
        label: `batch starting at ${i}`,
        maxAttempts,
        retryDelayMs,
        delay,
        logger,
      })) as { results?: unknown }
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        logger.error(`batch starting at ${i}: Groq quota exhausted (${err.message}), stopping run`)
      } else if (err instanceof RetriesExhaustedError) {
        logger.error(
          `batch starting at ${i}: Groq request failed after ${maxAttempts} attempts (${err.message}), stopping run`,
        )
      } else {
        throw err
      }
      break
    }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    const categoryAssignments: { id: number; category: string }[] = []

    for (const item of raw.results as RawEnrichmentItem[]) {
      if (
        typeof item.id !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.value_drivers !== 'string' ||
        typeof item.has_trained_price_knowledge !== 'boolean' ||
        typeof item.is_specific_product !== 'boolean' ||
        (item.confidence !== 'high' && item.confidence !== 'low')
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

      const trainedPriceLow = typeof item.trained_price_low === 'number' ? item.trained_price_low : null
      const trainedPriceHigh = typeof item.trained_price_high === 'number' ? item.trained_price_high : null

      await upsertProductEnrichment(
        db,
        candidate.id,
        {
          description: item.description,
          valueDrivers: item.value_drivers,
          hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
          trainedPriceLow,
          trainedPriceHigh,
          isSpecificProduct: item.is_specific_product,
          confidence: item.confidence,
        },
        MODEL,
      )
      logger.info(
        `product ${candidate.id} enriched (trained price known: ${item.has_trained_price_knowledge}, specific product: ${item.is_specific_product}/${item.confidence})`,
      )

      // category is best-effort here, unlike the enrichment fields above — a
      // malformed category doesn't invalidate the enrichment upsert that
      // already happened. Only ever fills a gap (candidate.category is
      // already null): a candidate arriving here with a category already
      // set (assigned at creation by extract-products.ts) keeps it as-is.
      if (candidate.category === null) {
        if (typeof item.category === 'string' && VALID_CATEGORIES.has(item.category)) {
          categoryAssignments.push({ id: candidate.id, category: item.category })
        } else {
          logger.warn(`product ${candidate.id}: malformed/invalid category in Groq response, leaving category unset`)
        }
      }
    }

    await updateProductCategories(db, categoryAssignments)
  }
}

async function main() {
  loadEnvFile()
  const groqApiKeys = loadGroqApiKeys(process.env)
  if (groqApiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  await runWorker({
    name: 'enrich-products',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: [
      'enrich_products.batch_size',
      'enrich_products.loop_delay_ms',
      'enrich_products.max_attempts',
      'enrich_products.retry_delay_ms',
    ],
    loopDelayKey: 'enrich_products.loop_delay_ms',
    setup: ({ logger, db }) => {
      // Per-key model fallback (best model first) round-robined across keys -
      // see createGroqPool. Logs every hop so a stuck key/model is visible.
      const groq = createGroqPool(groqApiKeys, (fromLabel, toLabel) =>
        logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
      )
      logger.info(`round-robining across ${groqApiKeys.length} Groq key(s)`)
      return async ({ settings }) => {
        const candidates = await getEnrichmentCandidates(db)
        return {
          dryRun: `marketplace will call Groq for enrichment on ${candidates.length} products this lap`,
          run: async () => {
            await runProductEnrichment(
              groq,
              db,
              logger,
              candidates,
              realDelay,
              settings['enrich_products.batch_size'],
              settings['enrich_products.max_attempts'],
              settings['enrich_products.retry_delay_ms'],
            )
            // Applies this lap's freshly-produced is_specific_product/confidence
            // judgments to price_lookup_excluded/price_lookup_review_status - lives
            // here rather than in flag-price-ineligible.ts (which only handles the
            // human-curated list, run manually) because this needs to react to new
            // enrichment rows on the same cadence they're produced, not on a
            // human's edit schedule.
            await applyEligibilityFromEnrichment(db)
          },
        }
      }
    },
  })
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
// (extract-products.ts hit this exact bug: importing its exported function
// for tests triggered a live main() run against real credentials.)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
