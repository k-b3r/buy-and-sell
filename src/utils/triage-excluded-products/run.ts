import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type { Logger } from '../../platform/logger'
import { callJson, failureText } from '../../platform/llm-clients'
import type { TriageCandidate, TriageRow } from '../../modules/pricing'
import { buildTriagePrompt, parseTriageItem, TRIAGE_RESPONSE_SCHEMA } from '../../modules/pricing'

// Confirmed live 2026-10-08: a 20-product batch on the gateway's `auto` route
// hit a 60s provider timeout (and Cloudflare's 100s cap in front of
// llm.kber.dev); 10 per batch ran 40 products in 16s via gpt-oss-120b.
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 5000

interface TriageIo {
  llm: { generateJson(prompt: string, schema: object): Promise<unknown> }
  saveRows: (rows: TriageRow[]) => Promise<void>
  logger: Logger
  delay?: DelayFn
}

// Triage in batches; stops cleanly when the gateway is exhausted or keeps
// failing. Rerunning resumes: saved products drop out of getTriageCandidates.
export async function runPriceTriage(
  { llm, saveRows, logger, delay = realDelay }: TriageIo,
  candidates: TriageCandidate[],
  { batchSize = DEFAULT_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<void> {
  logger.info(`${candidates.length} excluded products to triage`)
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const label = `batch starting at ${i}`
    const attempt = await callJson(llm, buildTriagePrompt(batch), TRIAGE_RESPONSE_SCHEMA, {
      provider: 'LLM gateway',
      label,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      delay,
      logger,
    })
    if (!attempt.ok) {
      logger.error(
        `${label}: LLM gateway unavailable (${failureText(attempt)}: ${attempt.message}), stopping run; rerun to resume`,
      )
      return
    }
    const raw = attempt.raw
    const results = (raw as { results?: unknown } | undefined)?.results
    if (!Array.isArray(results)) {
      logger.error(`${label}: unexpected response shape (no results array), skipping batch`)
      continue
    }
    const rows: TriageRow[] = []
    for (const item of results) {
      const parsed = parseTriageItem(item, batch)
      if (parsed.kind === 'ok') rows.push(parsed.row)
      else
        logger.warn(
          `${label}: item ${parsed.kind === 'malformed' ? parsed.idHint : parsed.id} ${parsed.kind}, skipping`,
        )
    }
    await saveRows(rows)
    logger.info(`${label}: saved ${rows.length}/${batch.length} verdicts`)
  }
}
