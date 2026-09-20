import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import { loadSettings } from '../../platform/settings'
import { buildRealEstatePrompt, REAL_ESTATE_RESPONSE_SCHEMA, normalizeRealEstateItem } from '../../domains/marketplace'
import type { RealEstateCandidate, RealEstateFields } from '../../domains/marketplace'
import { getRealEstateCandidates, upsertRealEstateDetails } from '../../domains/marketplace/storage/real-estate'

const MODEL = 'openai/gpt-oss-120b'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000
const LAP_CANDIDATE_LIMIT = 200

// A 429 means the key itself is dead - retrying smaller does not help, so it
// unwinds the whole run (same rule as the sub-category backfill).
export class QuotaExhaustedError extends Error {}

// Same halve-on-persistent-failure recovery the other Groq workers use: a
// smaller array gives the model less room to lose the response shape.
export async function extractRealEstateBatch(
  groq: GroqClient,
  logger: Logger,
  delay: DelayFn,
  batch: RealEstateCandidate[],
  retryMissing = true,
): Promise<Map<string, RealEstateFields>> {
  const prompt = buildRealEstatePrompt(batch)
  let raw: { results?: unknown } | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      raw = (await groq.generateJson(prompt, REAL_ESTATE_RESPONSE_SCHEMA)) as { results?: unknown }
      break
    } catch (err) {
      const message = summarizeGroqError(err)
      if ((err as { status?: unknown }).status === 429) {
        logger.error(`Groq quota exhausted (${message}), stopping run`)
        throw new QuotaExhaustedError(message)
      }
      if (attempt === MAX_ATTEMPTS) {
        if (batch.length === 1) {
          logger.error(`listing ${batch[0].id}: Groq failed after ${MAX_ATTEMPTS} attempts at batch size 1 (${message}), skipping`)
          return new Map()
        }
        const mid = Math.ceil(batch.length / 2)
        logger.error(`Groq failed after ${MAX_ATTEMPTS} attempts at batch size ${batch.length} (${message}), splitting ${mid} + ${batch.length - mid}`)
        const first = await extractRealEstateBatch(groq, logger, delay, batch.slice(0, mid))
        const second = await extractRealEstateBatch(groq, logger, delay, batch.slice(mid))
        return new Map([...first, ...second])
      }
      logger.warn(`Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying`)
      await delay(RETRY_DELAY_MS)
    }
  }

  const out = new Map<string, RealEstateFields>()
  if (!raw || !Array.isArray(raw.results)) {
    logger.error('unexpected response shape (no results array), skipping batch')
    return out
  }
  for (const item of raw.results as { id?: unknown }[]) {
    const id = typeof item?.id === 'string' ? item.id : null
    const candidate = id === null ? undefined : batch.find((c) => c.id === id)
    if (!candidate) {
      logger.warn(`item ${id ?? '(missing id)'}: no matching candidate in this batch, skipping`)
      continue
    }
    const fields = normalizeRealEstateItem(item, candidate)
    if (!fields) {
      logger.warn(`item ${candidate.id}: malformed fields in Groq response, skipping`)
      continue
    }
    out.set(candidate.id, fields)
  }

  // Confirmed on a real run: the model sometimes returns fewer results than it
  // was sent (17 of 25). Ask once more for just the missing ones; anything still
  // missing stays a candidate and is picked up next lap. Once only, so a model
  // that keeps omitting items cannot loop this.
  const missing = batch.filter((c) => !out.has(c.id))
  if (retryMissing && missing.length > 0) {
    logger.warn(`model returned ${out.size} of ${batch.length} listings, retrying the ${missing.length} missing`)
    const retried = await extractRealEstateBatch(groq, logger, delay, missing, false)
    for (const [id, fields] of retried) out.set(id, fields)
  }
  return out
}

export async function runRealEstateExtraction(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: RealEstateCandidate[],
  batchSize = 20,
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${candidates.length} real estate listings to extract`)
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    let extracted: Map<string, RealEstateFields>
    try {
      extracted = await extractRealEstateBatch(groq, logger, delay, batch)
    } catch (err) {
      if (err instanceof QuotaExhaustedError) return
      throw err
    }
    for (const candidate of batch) {
      const fields = extracted.get(candidate.id)
      if (!fields) continue
      await upsertRealEstateDetails(db, candidate.id, fields, MODEL, candidate.source_hash)
      logger.info(`listing ${candidate.id} extracted (${fields.property_type}, price basis ${fields.price_basis}, ${fields.confidence})`)
    }
  }
}

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys()
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — real estate extraction requires Postgres')

  const logger = createLogger('data/extract-real-estate.log')
  writePidFile('data/extract-real-estate.pid')
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) => logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`))
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getRealEstateCandidates(pool, LAP_CANDIDATE_LIMIT)
      const settings = await loadSettings(pool, ['extract_real_estate.batch_size', 'extract_real_estate.loop_delay_ms'])
      if (isTestRun()) {
        logger.info(`TEST_RUN: would call Groq to extract ${candidates.length} real estate listings this lap`)
      } else {
        await runRealEstateExtraction(groq, pool, logger, candidates, settings['extract_real_estate.batch_size'])
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['extract_real_estate.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['extract_real_estate.loop_delay_ms'])
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
