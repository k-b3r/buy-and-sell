import type { Logger } from '../../platform/logger'
import { summarizeError } from '../../platform/errors'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { buildRealEstatePrompt, REAL_ESTATE_RESPONSE_SCHEMA, parseRealEstateResponse } from './extraction'
import type { RealEstateCandidate, RealEstateFields } from './extraction'
import { upsertRealEstateDetails } from './details'

// The I/O port this module needs from an LLM client; a Groq pool satisfies it.
export interface JsonModelClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

const MODEL = 'openai/gpt-oss-120b'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000

// gpt-oss-120b only. Confirmed live 2026-09-24: once its quota ran out, the shared
// chain's qwen fallbacks kept producing JSON that fails this schema (Groq 400s), so
// they burned requests without saving anything. On 120b exhaustion the lap now
// stops (429 -> QuotaExhaustedError) and resumes next lap; unextracted listings stay
// candidates, so nothing is lost.
export const EXTRACTOR_MODELS = ['openai/gpt-oss-120b'] as const

// Passed to the Groq pool as GroqRequestOptions: default reasoning truncated
// 20-listing batches. With a 10-listing batch (~2500 prompt tokens) a 4096 cap
// stays under the 8000 TPM limit.
export const EXTRACTOR_REQUEST_OPTIONS = { reasoningEffort: 'low', maxCompletionTokens: 4096 } as const

// A 429 means the key itself is dead - retrying smaller does not help, so it
// unwinds the whole run (same rule as the sub-category backfill).
class QuotaExhaustedError extends Error {}

// Same halve-on-persistent-failure recovery the other Groq workers use: a
// smaller array gives the model less room to lose the response shape.
export async function extractRealEstateBatch(
  groq: JsonModelClient,
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
      const message = summarizeError(err)
      if ((err as { status?: unknown }).status === 429) {
        logger.error(`Groq quota exhausted (${message}), stopping run`)
        throw new QuotaExhaustedError(message)
      }
      if (attempt === MAX_ATTEMPTS) {
        if (batch.length === 1) {
          logger.error(
            `listing ${batch[0].id}: Groq failed after ${MAX_ATTEMPTS} attempts at batch size 1 (${message}), skipping`,
          )
          return new Map()
        }
        const mid = Math.ceil(batch.length / 2)
        logger.error(
          `Groq failed after ${MAX_ATTEMPTS} attempts at batch size ${batch.length} (${message}), splitting ${mid} + ${batch.length - mid}`,
        )
        const first = await extractRealEstateBatch(groq, logger, delay, batch.slice(0, mid))
        const second = await extractRealEstateBatch(groq, logger, delay, batch.slice(mid))
        return new Map([...first, ...second])
      }
      logger.warn(`Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying`)
      await delay(RETRY_DELAY_MS)
    }
  }

  const parsed = parseRealEstateResponse(raw, batch)
  if (!parsed) {
    logger.error('unexpected response shape (no results array), skipping batch')
    return new Map()
  }
  for (const line of parsed.skipped) logger.warn(line)
  const out = parsed.fields

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
  groq: JsonModelClient,
  db: DbClient,
  logger: Logger,
  candidates: RealEstateCandidate[],
  batchSize = 10,
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
      logger.info(
        `listing ${candidate.id} extracted (${fields.property_type}, price basis ${fields.price_basis}, ${fields.confidence})`,
      )
    }
  }
}
