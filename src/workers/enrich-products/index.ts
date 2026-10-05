import { fileURLToPath } from 'node:url'
import { createGroqPool, loadGroqApiKeys } from '../../domains/llm-clients'
import { realDelay } from '../../platform/delay'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { getEnrichmentCandidates, runProductEnrichment } from '../../modules/catalog'
import { applyEligibilityFromEnrichment } from '../../modules/pricing'

async function main() {
  loadEnvFile()
  const groqApiKeys = loadGroqApiKeys(process.env)
  if (groqApiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  await runWorker({
    name: 'enrich-products',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: [
      'enrich_products.batch_size',
      'enrich_products.loop_delay_ms',
      'enrich_products.max_attempts',
      'enrich_products.retry_delay_ms',
    ],
    loopDelayKey: 'enrich_products.loop_delay_ms',
    setup: ({ logger, db }) => {
      // Per-key model fallback (best model first) round-robined across keys -
      // see createGroqPool. Logs every hop so a stuck key/model is visible.
      const groq = createGroqPool(groqApiKeys, (fromLabel, toLabel) =>
        logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
      )
      logger.info(`round-robining across ${groqApiKeys.length} Groq key(s)`)
      return async ({ settings }) => {
        const candidates = await getEnrichmentCandidates(db)
        return {
          dryRun: `marketplace will call Groq for enrichment on ${candidates.length} products this lap`,
          run: async () => {
            await runProductEnrichment(
              groq,
              db,
              logger,
              candidates,
              realDelay,
              settings['enrich_products.batch_size'],
              settings['enrich_products.max_attempts'],
              settings['enrich_products.retry_delay_ms'],
            )
            // Applies this lap's freshly-produced is_specific_product/confidence
            // judgments to price_lookup_excluded/price_lookup_review_status - lives
            // here rather than in flag-price-ineligible.ts (which only handles the
            // human-curated list, run manually) because this needs to react to new
            // enrichment rows on the same cadence they're produced, not on a
            // human's edit schedule.
            await applyEligibilityFromEnrichment(db)
          },
        }
      }
    },
  })
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
