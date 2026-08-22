import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GroqClient } from './groq'
import { createGroqClient } from './groq'
import type { DbClient } from './db'
import { createDbPool, getEnrichmentCandidates, upsertProductEnrichment } from './db'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from './enrichment'
import type { EnrichmentCandidate } from './enrichment'

// Originally sized at 35 from output-token math alone — wrong, because
// gpt-oss-120b is a reasoning model: it spends hidden "thinking" tokens before
// the JSON, which don't show up in a token-per-field estimate and vary
// non-deterministically run to run. Confirmed live (2026-08-22) against the
// real first batch of pending candidates: n=20 succeeds cleanly (well under
// Groq's 8,000 TPM cap even with reasoning overhead), n=25/30 pass but butt
// up against an apparent ~3,072-token completion ceiling, n=35 fails outright
// with an unhelpful "Failed to validate JSON" 400 (truncated mid-generation,
// not a real schema problem — Groq's error message doesn't say so).
const BATCH_SIZE = 20
const MODEL = 'openai/gpt-oss-120b'

export type DelayFn = (ms: number) => Promise<void>
const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// gpt-oss-120b occasionally (non-deterministically) wraps the array as
// {"results":{"items":[...]}} instead of {"results":[...]} — confirmed live
// (2026-08-22): replaying the exact same failing batch, attempt 1 and 2
// succeeded, attempt 3 failed this way. Worth a few retries. A real 429 quota
// error is different — retrying just burns more of an already-exhausted
// budget for nothing, so it's excluded and fails on the first hit.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
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
    // the process (see src/price-lookup.ts's generateGroundedTextWithRetry for the
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

    for (const item of raw.results as RawEnrichmentItem[]) {
      if (
        typeof item.id !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.value_drivers !== 'string' ||
        typeof item.has_trained_price_knowledge !== 'boolean'
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
        },
        MODEL,
      )
      logger.info(`product ${candidate.id} enriched (trained price known: ${item.has_trained_price_knowledge})`)
    }
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GROQ_API_KEY
  if (!apiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  const logger = createLogger('data/enrich-products.log')
  const groq = createGroqClient(apiKey, MODEL)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getEnrichmentCandidates(pool)
    await runProductEnrichment(groq, pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('product enrichment complete')
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
