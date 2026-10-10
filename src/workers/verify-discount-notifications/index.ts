import { fileURLToPath } from 'node:url'
import type { DiscountPolicyThresholds, VerificationClients } from '../../modules/pricing'
import { getUnverifiedDiscountCandidates, runVerifyDiscountNotifications } from '../../modules/pricing'
import {
  createTavilyClient,
  createExaClient,
  createFallbackExaClient,
  loadExaApiKeys,
  createDailyGroundingCap,
  createOpenRouterClient,
  loadGatewayConfig,
  withGateway,
} from '../../platform/llm-clients'
import { createGeminiClient } from '../../platform/llm-clients/gemini-sdk'
import { realDelay } from '../../platform/delay'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { loadSettings } from '../../platform/settings'

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
  const gatewayConfig = loadGatewayConfig(process.env, 'verify-discount-notifications')
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

  await runWorker({
    name: 'verify-discount-notifications',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: [
      'verify_discount.lap_limit_default',
      'verify_discount.fetch_batch_size',
      'verify_discount.loop_delay_ms',
      'verify_discount.pacing_delay_ms',
      'discount_policy.high_discount_threshold_percent',
      'discount_policy.min_profit_pesos',
      'discount_policy.min_price_pesos',
    ],
    loopDelayKey: 'verify_discount.loop_delay_ms',
    setup: ({ logger, db }) => {
      // Exa is now the primary market-context source (see discount-verification.ts's
      // fetchFreshMarketContext comment) - its credits ran out mid-investigation
      // (2026-08-31, real 402), so multiple keys are worth having on hand here
      // (see loadExaApiKeys).
      logger.info(`${exaApiKeys.length} Exa API key(s) configured`)

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
          const settings = await loadSettings(db, ['discount_policy.gemini_daily_grounding_cap'])
          return settings['discount_policy.gemini_daily_grounding_cap']
        }),
        openrouter: withGateway(createOpenRouterClient(openRouterApiKey), gatewayConfig, { db, logger }),
      }

      return async ({ settings }) => {
        const limit = explicitLimit ?? settings['verify_discount.lap_limit_default']
        const thresholds: DiscountPolicyThresholds = {
          highDiscountThresholdPercent: settings['discount_policy.high_discount_threshold_percent'],
          minProfitPesos: settings['discount_policy.min_profit_pesos'],
          minPricePesos: settings['discount_policy.min_price_pesos'],
        }
        const pending = await getUnverifiedDiscountCandidates(
          db,
          settings['verify_discount.fetch_batch_size'],
          thresholds.minPricePesos,
        )
        logger.info(`${pending.length} pending this lap`)
        return {
          dryRun: `would verify ${pending.length} discount notifications this lap`,
          run: () =>
            runVerifyDiscountNotifications({ clients, db, logger, delay: realDelay }, pending, {
              paidLimit: limit,
              pacingDelayMs: settings['verify_discount.pacing_delay_ms'],
              thresholds,
            }),
        }
      }
    },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
