import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import { createGeminiClient, createExaClient, createFallbackExaClient, loadExaApiKeys, createTavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { PriceLookupCandidate, PriceLookupClients } from '../../domains/marketplace'
import { ensureProductPriced } from '../../domains/marketplace'
import { getPriceLookupCandidates } from '../../domains/marketplace/storage/pricing'
import { loadSettings } from '../../platform/settings'

export type { PriceLookupClients } from '../../domains/marketplace'

// Each product is independent - a failure on one doesn't stop the lap.
// All the actual provider-chain/exclusion logic lives in
// ensureProductPriced (domains/marketplace/price-lookup.ts), shared with
// extract-products.ts's inline per-listing trigger - this loop is just the
// backfill pass over whatever getPriceLookupCandidates still finds
// unpriced (extraction's own inline attempt is now the primary path for
// brand-new products; this worker mainly catches anything that slipped
// through - a failed inline attempt, a listing extracted before this
// worker existed, etc).
export async function runPriceLookup(
  clients: PriceLookupClients,
  db: DbClient,
  logger: Logger,
  products: PriceLookupCandidate[],
  delay: DelayFn = realDelay,
  pacingDelayMs = 1000,
): Promise<void> {
  logger.info(`${products.length} products to check for retail/secondhand price`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await delay(pacingDelayMs)
    await ensureProductPriced(clients, db, products[i], logger)
  }
}

async function main() {
  loadEnvFile()

  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const exaApiKeys = loadExaApiKeys()
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

  const logger = createLogger('data/price-lookup.log')
  writePidFile('data/price-lookup.pid')

  // Exa is the primary source for both retail and secondhand - its credits
  // ran out mid-investigation once already (2026-08-31, real 402), so
  // multiple keys are worth having on hand (see loadExaApiKeys).
  logger.info(`${exaApiKeys.length} Exa API key(s) configured`)

  const clients: PriceLookupClients = {
    // Free tier only (per direct instruction: no paid Gemini in the app).
    // Its real ~20 req/day/key wall is Google's own enforcement (a 429, no
    // client-side cap needed like the paid-tier grounding case) - a quota
    // hit here just falls through to Exa the same lap, same as any other
    // failure.
    gemini: createGeminiClient(geminiApiKey),
    exa: createFallbackExaClient(exaApiKeys.map(createExaClient)),
    tavily: createTavilyClient(tavilyApiKey),
  }

  const pool = createDbPool(dbUrl)

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const settings = await loadSettings(pool, [
        'price_lookup.lap_limit_default',
        'price_lookup.loop_delay_ms',
        'price_lookup.pacing_delay_ms',
      ])
      const limit = explicitLimit ?? settings['price_lookup.lap_limit_default']
      const pending = await getPriceLookupCandidates(pool)
      const products = pending.slice(0, limit)
      logger.info(`${pending.length} pending price lookup, processing ${products.length} this lap`)
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Gemini/Exa/Tavily for retail/secondhand price-lookup on ${products.length} products this lap`)
      } else {
        await runPriceLookup(clients, pool, logger, products, realDelay, settings['price_lookup.pacing_delay_ms'])
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['price_lookup.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['price_lookup.loop_delay_ms'])
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
