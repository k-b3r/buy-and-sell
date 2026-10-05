import { fileURLToPath } from 'node:url'
import {
  createFallbackGeminiClient,
  createQuotaAwareGeminiClient,
  loadGroqApiKeys,
  createExaClient,
  createFallbackExaClient,
  loadExaApiKeys,
  createTavilyClient,
} from '../../domains/llm-clients'
import { createGeminiClient } from '../../domains/llm-clients/gemini-sdk'
import { createGroqPool } from '../../domains/llm-clients/groq-sdk'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import type { ExtractionClients } from '../../modules/catalog'
import { getExtractionCandidates, runProductExtraction } from '../../modules/catalog'

async function main() {
  loadEnvFile()
  const groqApiKeys = loadGroqApiKeys(process.env)
  if (groqApiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const exaApiKeys = loadExaApiKeys(process.env)
  if (exaApiKeys.length === 0) throw new Error('No EXA_API_KEY<n> (EXA_API_KEY0, EXA_API_KEY1, ...) set in .env')
  const tavilyApiKey = process.env.TAVILY_API_KEY
  if (!tavilyApiKey) throw new Error('TAVILY_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product extraction requires Postgres')
  const altGeminiApiKey = process.env.ALT_FREE_GEMINI_API_KEY

  await runWorker({
    name: 'extract-products',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: [
      'extract_products.batch_size',
      'extract_products.inter_batch_delay_ms',
      'extract_products.max_attempts',
      'extract_products.retry_base_delay_ms',
      'extract_products.loop_delay_ms',
      'discount_policy.high_discount_threshold_percent',
      'discount_policy.min_profit_pesos',
      'discount_policy.min_price_pesos',
    ],
    loopDelayKey: 'extract_products.loop_delay_ms',
    setup: ({ logger, db }) => {
      // Same shape as enrich-products.ts - see createGroqPool. Logs every
      // model/key hop so a stuck one is visible.
      const groq = createGroqPool(groqApiKeys, (fromLabel, toLabel) =>
        logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
      )
      logger.info(`round-robining across ${groqApiKeys.length} Groq key(s)`)

      // Free tier is 20 requests/day per project per model — a second key from a
      // different Google account is a different project, so it has its own
      // independent quota. Gemini is now the fallback provider (see
      // DEFAULT_MAX_ATTEMPTS in modules/catalog/run-extraction.ts), tried only once Groq is exhausted.
      const geminiForExtraction = altGeminiApiKey
        ? createFallbackGeminiClient([
            createGeminiClient(geminiApiKey),
            createGeminiClient(altGeminiApiKey, 'gemini-3.6-flash'),
          ])
        : createGeminiClient(geminiApiKey)
      if (altGeminiApiKey) {
        logger.info('ALT_FREE_GEMINI_API_KEY configured, will fall back to it (gemini-3.6-flash) on quota exhaustion')
      }
      // This same client also fills PriceLookupClients' gemini role below
      // (generateGroundedText, now primary for both retail and secondhand - see
      // modules/pricing/price-lookup.ts's buildGeminiPrompt comment).
      // createQuotaAwareGeminiClient only gates generateGroundedText - once
      // that side hits the real 20/day wall (confirmed live 2026-09-02, see
      // gemini.ts), price lookups skip straight to Exa for the rest of the day
      // without a doomed round-trip; generateJson (this worker's own
      // extraction calls) passes through untouched.
      const gemini = createQuotaAwareGeminiClient(geminiForExtraction)
      // Exa is fallback 1 for both retail and secondhand pricing (Gemini's
      // primary) - its credits ran out mid-investigation once already
      // (2026-08-31, real 402), so multiple keys are worth having on hand here
      // too (see loadExaApiKeys).
      logger.info(`${exaApiKeys.length} Exa API key(s) configured`)
      const exa = createFallbackExaClient(exaApiKeys.map(createExaClient))
      const tavily = createTavilyClient(tavilyApiKey)

      const clients: ExtractionClients = { groq, gemini, exa, tavily }
      return async ({ settings }) => {
        const candidates = await getExtractionCandidates(db)
        return {
          dryRun: `marketplace will call Groq for extraction on ${candidates.length} listings this lap`,
          run: () =>
            runProductExtraction({ clients, db, logger }, candidates, {
              // batchSize was tuned around Gemini's 20 req/day cap (confirmed
              // live 2026-08-20) - unverified whether 100/batch is still the
              // right size now that Groq (TPM-capped, not daily-request-capped)
              // is primary. Left as-is pending a live batch-size audit, same
              // status as enrich-listing-prices.ts's 35 and
              // backfill-categories.ts's 100 (see pipeline-consolidation plan).
              batchSize: settings['extract_products.batch_size'],
              delayMs: settings['extract_products.inter_batch_delay_ms'],
              maxAttempts: settings['extract_products.max_attempts'],
              retryBaseDelayMs: settings['extract_products.retry_base_delay_ms'],
              discountThresholds: {
                highDiscountThresholdPercent: settings['discount_policy.high_discount_threshold_percent'],
                minProfitPesos: settings['discount_policy.min_profit_pesos'],
                minPricePesos: settings['discount_policy.min_price_pesos'],
              },
            }),
        }
      }
    },
  })
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
