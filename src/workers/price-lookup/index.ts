import { fileURLToPath } from 'node:url'
import {
  createQuotaAwareGeminiClient,
  createExaClient,
  createFallbackExaClient,
  loadExaApiKeys,
  createTavilyClient,
} from '../../platform/llm-clients'
import { createGeminiClient } from '../../platform/llm-clients/gemini-sdk'
import { realDelay } from '../../platform/delay'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import type { PriceLookupClients } from '../../modules/pricing'
import { getPriceLookupCandidates, runPriceLookup } from '../../modules/pricing'

async function main() {
  loadEnvFile()

  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const exaApiKeys = loadExaApiKeys(process.env)
  if (exaApiKeys.length === 0) throw new Error('No EXA_API_KEY<n> (EXA_API_KEY0, EXA_API_KEY1, ...) set in .env')
  const tavilyApiKey = process.env.TAVILY_API_KEY
  if (!tavilyApiKey) throw new Error('TAVILY_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price lookup requires Postgres')

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
    name: 'price-lookup',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: ['price_lookup.lap_limit_default', 'price_lookup.loop_delay_ms', 'price_lookup.pacing_delay_ms'],
    loopDelayKey: 'price_lookup.loop_delay_ms',
    setup: ({ logger, db }) => {
      // Exa is fallback 1 for both retail and secondhand (Gemini's primary, see
      // price-lookup.ts's buildGeminiPrompt comment) - its credits ran out
      // mid-investigation once already (2026-08-31, real 402), so multiple keys
      // are worth having on hand (see loadExaApiKeys).
      logger.info(`${exaApiKeys.length} Exa API key(s) configured`)

      const clients: PriceLookupClients = {
        // Free tier only (per direct instruction: no paid Gemini in the app).
        // Its real wall is a flat 20/day for the whole model (confirmed live
        // 2026-09-02 by reproducing the actual 429 - see gemini.ts's comment),
        // Google's own enforcement, not a client-side guess. Wrapped in
        // createQuotaAwareGeminiClient so once that 429 is seen, every later
        // call this same day skips straight to Exa instead of spending a
        // round-trip on a call already known to fail.
        gemini: createQuotaAwareGeminiClient(createGeminiClient(geminiApiKey)),
        exa: createFallbackExaClient(exaApiKeys.map(createExaClient)),
        tavily: createTavilyClient(tavilyApiKey),
      }

      return async ({ settings }) => {
        const limit = explicitLimit ?? settings['price_lookup.lap_limit_default']
        const pending = await getPriceLookupCandidates(db)
        const products = pending.slice(0, limit)
        logger.info(`${pending.length} pending price lookup, processing ${products.length} this lap`)
        return {
          dryRun: `would call Gemini/Exa/Tavily for retail/secondhand price-lookup on ${products.length} products this lap`,
          run: () =>
            runPriceLookup(
              { clients, db, logger, delay: realDelay },
              products,
              settings['price_lookup.pacing_delay_ms'],
            ),
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
