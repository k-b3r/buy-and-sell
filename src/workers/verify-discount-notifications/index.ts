import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { VerificationClients } from '../../domains/marketplace'
import { verifyDiscountCandidate, precheckDiscountCandidate } from '../../domains/marketplace'
import {
  createTavilyClient,
  createExaClient,
  createFallbackExaClient,
  loadExaApiKeys,
  createGeminiClient,
  createDailyGroundingCap,
  createOpenRouterClient,
} from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { DiscountVerificationCandidate, DiscountPolicyThresholds } from '../../domains/marketplace'
import {
  getUnverifiedDiscountCandidates,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
  markDiscountNotificationAttempted,
  DEFAULT_DISCOUNT_POLICY,
} from '../../domains/marketplace'
import { loadSettings } from '../../platform/settings'

// Each candidate is independent - a failure judging one (network blip,
// unexpected throw) is logged and skipped via the pending path, never fatal
// to the rest of the lap. verifyDiscountCandidate itself never throws (see
// its own fail-closed design), so this loop's job is purely dispatching its
// outcome to the right storage call.
//
// Two-tier budget: precheckDiscountCandidate (free, synchronous) runs
// against every candidate in the batch, uncapped. Only candidates it clears
// ('proceed') draw against paidLimit - once that's used up, remaining
// proceed-able candidates are left completely untouched (no attempt
// timestamp bumped) so they're still first in line, unpenalized, next lap.
export async function runVerifyDiscountNotifications(
  clients: VerificationClients,
  db: DbClient,
  logger: Logger,
  candidates: DiscountVerificationCandidate[],
  paidLimit: number = Infinity,
  delay: DelayFn = realDelay,
  pacingDelayMs = 1000,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<void> {
  logger.info(`${candidates.length} discount notifications pending verification`)

  let paidUsed = 0
  for (const candidate of candidates) {
    const pre = precheckDiscountCandidate(candidate, thresholds)

    if (pre.outcome === 'rejected') {
      await rejectDiscountNotification(db, candidate.id)
      logger.info(`candidate ${candidate.id} (${candidate.base_model}): rejected — ${pre.reasoning}`)
      continue
    }
    if (pre.outcome === 'pending') {
      await markDiscountNotificationAttempted(db, candidate.id)
      logger.warn(`candidate ${candidate.id} (${candidate.base_model}): pending — ${pre.reasoning}`)
      continue
    }

    if (paidUsed >= paidLimit) {
      logger.info(
        `candidate ${candidate.id} (${candidate.base_model}): leaving for next lap, paid-call budget (${paidLimit}) used up this lap`,
      )
      continue
    }
    if (paidUsed > 0) await delay(pacingDelayMs)
    paidUsed++

    try {
      const result = await verifyDiscountCandidate(candidate, clients, thresholds)

      if (result.outcome === 'verified') {
        await markDiscountNotificationVerified(db, candidate.id, {
          discountPercent: result.discountPercent,
          referencePrice: result.referencePrice,
          source: result.source,
          reasoning: result.reasoning,
        })
        logger.info(
          `candidate ${candidate.id} (${candidate.base_model}): verified, ${result.discountPercent}% off via ${result.source}`,
        )
      } else if (result.outcome === 'rejected') {
        await rejectDiscountNotification(db, candidate.id)
        logger.info(`candidate ${candidate.id} (${candidate.base_model}): rejected — ${result.reasoning}`)
      } else {
        await markDiscountNotificationAttempted(db, candidate.id)
        logger.warn(`candidate ${candidate.id} (${candidate.base_model}): pending — ${result.reasoning}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `candidate ${candidate.id} (${candidate.base_model}): unexpected error (${message}), skipping this lap`,
      )
    }
  }
}

async function main() {
  loadEnvFile()

  const tavilyApiKey = process.env.TAVILY_API_KEY
  if (!tavilyApiKey) throw new Error('TAVILY_API_KEY not set in .env')
  const exaApiKeys = loadExaApiKeys(process.env)
  if (exaApiKeys.length === 0) throw new Error('No EXA_API_KEY<n> (EXA_API_KEY0, EXA_API_KEY1, ...) set in .env')
  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const openRouterApiKey = process.env.OPEN_ROUTER_PRODUCT_JUDGE_API_KEY
  if (!openRouterApiKey) throw new Error('OPEN_ROUTER_PRODUCT_JUDGE_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — verification requires Postgres')

  const limitArg = process.argv.slice(2).filter((arg) => arg !== '--')[0]
  let explicitLimit: number | undefined
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    explicitLimit = parsed
  }

  const logger = createLogger('data/verify-discount-notifications.log')
  writePidFile('data/verify-discount-notifications.pid')

  // Exa is now the primary market-context source (see discount-verification.ts's
  // fetchFreshMarketContext comment) - its credits ran out mid-investigation
  // (2026-08-31, real 402), so multiple keys are worth having on hand here
  // (see loadExaApiKeys).
  logger.info(`${exaApiKeys.length} Exa API key(s) configured`)

  const pool = createDbPool(dbUrl)

  const clients: VerificationClients = {
    tavily: createTavilyClient(tavilyApiKey),
    exa: createFallbackExaClient(exaApiKeys.map(createExaClient)),
    // Gemini is the last-resort fallback in the market-context chain here -
    // low volume already, but its grounded search has no real Google-side
    // spend guardrail on a paid key (exceeding the free daily allowance just
    // bills more, silently), so it's client-side capped instead. See
    // gemini.ts's createDailyGroundingCap comment for the full reasoning.
    // The cap is a live getter (not a fixed number) so a dashboard edit to
    // discount_policy.gemini_daily_grounding_cap takes effect on the very
    // next grounded call, not just the next process restart.
    gemini: createDailyGroundingCap(createGeminiClient(geminiApiKey), async () => {
      const settings = await loadSettings(pool, ['discount_policy.gemini_daily_grounding_cap'])
      return settings['discount_policy.gemini_daily_grounding_cap']
    }),
    openrouter: createOpenRouterClient(openRouterApiKey),
  }

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const settings = await loadSettings(pool, [
        'verify_discount.lap_limit_default',
        'verify_discount.fetch_batch_size',
        'verify_discount.loop_delay_ms',
        'verify_discount.pacing_delay_ms',
        'discount_policy.high_discount_threshold_percent',
        'discount_policy.min_profit_pesos',
        'discount_policy.min_price_pesos',
      ])
      const limit = explicitLimit ?? settings['verify_discount.lap_limit_default']
      const thresholds: DiscountPolicyThresholds = {
        highDiscountThresholdPercent: settings['discount_policy.high_discount_threshold_percent'],
        minProfitPesos: settings['discount_policy.min_profit_pesos'],
        minPricePesos: settings['discount_policy.min_price_pesos'],
      }
      const pending = await getUnverifiedDiscountCandidates(
        pool,
        settings['verify_discount.fetch_batch_size'],
        thresholds.minPricePesos,
      )
      logger.info(`${pending.length} pending this lap`)
      if (isTestRun(process.env)) {
        logger.info(`TEST_RUN: would verify ${pending.length} discount notifications this lap`)
      } else {
        await runVerifyDiscountNotifications(
          clients,
          pool,
          logger,
          pending,
          limit,
          realDelay,
          settings['verify_discount.pacing_delay_ms'],
          thresholds,
        )
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['verify_discount.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['verify_discount.loop_delay_ms'])
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
