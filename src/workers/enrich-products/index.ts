import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqClient, createFallbackGroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile } from '../../platform/utils'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from '../../domains/marketplace'
import type { EnrichmentCandidate } from '../../domains/marketplace'
import {
  getEnrichmentCandidates,
  upsertProductEnrichment,
  applyEligibilityFromEnrichment,
  updateProductCategories,
} from '../../domains/marketplace/storage/products'
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
const BATCH_SIZE = 20
const MODEL = 'openai/gpt-oss-120b'

// Runs forever, not once - re-queries getEnrichmentCandidates every lap so
// newly-extracted products (extract-products.ts adds more over time) get
// picked up without a restart, and a lap that stopped early (Groq quota
// exhausted, a persistent malformed-response error) just gets retried after
// the pause instead of requiring the script to be manually re-run each time.
const LOOP_DELAY_MS = 300000

// gpt-oss-120b occasionally (non-deterministically) wraps the array as
// {"results":{"items":[...]}} instead of {"results":[...]} — confirmed live
// (2026-08-22): replaying the exact same failing batch, attempt 1 and 2
// succeeded, attempt 3 failed this way. Worth a few retries. A real 429 quota
// error is different — retrying just burns more of an already-exhausted
// budget for nothing, so it's excluded and fails on the first hit.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

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
): Promise<void> {
  logger.info(`${candidates.length} products to enrich`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildEnrichmentPrompt(batch)

    // Groq's daily token cap (see spec's Open Risks) is expected to be hit mid-run
    // on the full backlog, and a truncated/malformed response can throw a JSON
    // parse error inside generateJson too — either way this must be a recorded,
    // clean stop, not an uncaught throw that silently truncates the log and kills
    // the process (see src/workers/secondhand-price-lookup's generateGroundedTextWithRetry for the
    // same "don't let this class of error crash uncaught" precedent).
    let raw: { results?: unknown } | undefined
    let fatal = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        raw = (await groq.generateJson(prompt, ENRICHMENT_RESPONSE_SCHEMA)) as { results?: unknown }
        break
      } catch (err) {
        const status = (err as { status?: unknown }).status
        const message = err instanceof Error ? err.message : String(err)
        if (status === 429) {
          logger.error(`batch starting at ${i}: Groq quota exhausted (${message}), stopping run`)
          fatal = true
          break
        }
        if (attempt === MAX_ATTEMPTS) {
          logger.error(`batch starting at ${i}: Groq request failed after ${MAX_ATTEMPTS} attempts (${message}), stopping run`)
          fatal = true
          break
        }
        logger.warn(`batch starting at ${i}: Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message})`)
        await delay(RETRY_DELAY_MS)
      }
    }
    if (fatal) break

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
  const apiKey = process.env.FREE_GROQ_API_KEY
  if (!apiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  const logger = createLogger('data/enrich-products.log')
  const clients = [createGroqClient(apiKey, MODEL), createGroqClient(apiKey, 'openai/gpt-oss-20b')]
  const altApiKey = process.env.ALT_FREE_GROQ_API_KEY
  if (altApiKey) {
    clients.push(createGroqClient(altApiKey, MODEL), createGroqClient(altApiKey, 'openai/gpt-oss-20b'))
    logger.info('ALT_FREE_GROQ_API_KEY configured, will fall back to it once the primary key is exhausted')
  }
  const groq = createFallbackGroqClient(clients)
  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getEnrichmentCandidates(pool)
      await runProductEnrichment(groq, pool, logger, candidates)
      // Applies this lap's freshly-produced is_specific_product/confidence
      // judgments to price_lookup_excluded/price_lookup_review_status - lives
      // here rather than in flag-price-ineligible.ts (which only handles the
      // human-curated list, run manually) because this needs to react to new
      // enrichment rows on the same cadence they're produced, not on a
      // human's edit schedule.
      await applyEligibilityFromEnrichment(pool)
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
// (extract-products.ts hit this exact bug: importing its exported function
// for tests triggered a live main() run against real credentials.)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
