import { fileURLToPath } from 'node:url'
import { loadGroqApiKeys } from '../../platform/llm-clients'
import { createGroqPool } from '../../platform/llm-clients/groq-sdk'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { getPriceReviewCandidates, runPriceReview } from '../../modules/pricing'

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys(process.env)
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price review requires Postgres')

  await runWorker({
    name: 'enrich-listing-prices',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: ['enrich_listing_prices.batch_size', 'enrich_listing_prices.loop_delay_ms'],
    loopDelayKey: 'enrich_listing_prices.loop_delay_ms',
    setup: ({ logger, db }) => {
      const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
        logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
      )
      logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
      return async ({ settings }) => {
        const candidates = await getPriceReviewCandidates(db)
        return {
          dryRun: `would call Groq for price review on ${candidates.length} listings this lap`,
          run: () => runPriceReview({ groq, db, logger }, candidates, settings['enrich_listing_prices.batch_size']),
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
