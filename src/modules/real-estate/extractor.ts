import type { Logger } from '../../platform/logger'
import type { DelayFn } from '../../platform/delay'
import { withRetryAndSplit } from '../../platform/llm-clients'
import { buildRealEstatePrompt, REAL_ESTATE_RESPONSE_SCHEMA, parseRealEstateResponse } from './extraction'
import type { JsonModelClient, RealEstateCandidate, RealEstateFields } from './types'

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

// Same halve-on-persistent-failure recovery the other Groq workers use
// (withRetryAndSplit): a smaller array gives the model less room to lose the
// response shape. A quota error unwinds as QuotaExhaustedError.
export interface ExtractorDeps {
  groq: JsonModelClient
  logger: Logger
  delay: DelayFn
}

export async function extractRealEstateBatch(
  deps: ExtractorDeps,
  batch: RealEstateCandidate[],
  retryMissing = true,
): Promise<Map<string, RealEstateFields>> {
  const { groq, logger, delay } = deps
  async function handleResponse(part: RealEstateCandidate[], raw: unknown): Promise<[string, RealEstateFields][]> {
    const parsed = parseRealEstateResponse(raw, part)
    if (!parsed) {
      logger.error('unexpected response shape (no results array), skipping batch')
      return []
    }
    for (const line of parsed.skipped) logger.warn(line)
    const out = parsed.fields

    // Confirmed on a real run: the model sometimes returns fewer results than it
    // was sent (17 of 25). Ask once more for just the missing ones; anything still
    // missing stays a candidate and is picked up next lap. Once only, so a model
    // that keeps omitting items cannot loop this. Split halves of the retry call
    // honor its retryMissing=false too, or each would fire another Groq call.
    const missing = part.filter((c) => !out.has(c.id))
    if (retryMissing && missing.length > 0) {
      logger.warn(`model returned ${out.size} of ${part.length} listings, retrying the ${missing.length} missing`)
      const retried = await extractRealEstateBatch(deps, missing, false)
      for (const [id, fields] of retried) out.set(id, fields)
    }
    return [...out]
  }

  const entries = await withRetryAndSplit({
    items: batch,
    request: (part) => groq.generateJson(buildRealEstatePrompt(part), REAL_ESTATE_RESPONSE_SCHEMA),
    onResponse: handleResponse,
    itemId: (candidate) => candidate.id,
    provider: 'Groq',
    maxAttempts: MAX_ATTEMPTS,
    retryDelayMs: RETRY_DELAY_MS,
    delay,
    logger,
  })
  return new Map(entries)
}
