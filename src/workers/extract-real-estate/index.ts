import { fileURLToPath } from 'node:url'
import { loadGatewayConfig, loadGroqApiKeys, withGateway } from '../../platform/llm-clients'
import { createGroqPool } from '../../platform/llm-clients/groq-sdk'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import {
  EXTRACTOR_MODELS,
  EXTRACTOR_REQUEST_OPTIONS,
  getRealEstateCandidates,
  runRealEstateExtraction,
} from '../../modules/real-estate'

const LAP_CANDIDATE_LIMIT = 200

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys(process.env)
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const gatewayConfig = loadGatewayConfig(process.env, 'extract-real-estate')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — real estate extraction requires Postgres')

  await runWorker({
    name: 'extract-real-estate',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: ['extract_real_estate.batch_size', 'extract_real_estate.loop_delay_ms'],
    loopDelayKey: 'extract_real_estate.loop_delay_ms',
    setup: ({ logger, db }) => {
      const groq = withGateway(
        createGroqPool(
          apiKeys,
          (fromLabel, toLabel) => logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
          EXTRACTOR_MODELS,
          EXTRACTOR_REQUEST_OPTIONS,
        ),
        gatewayConfig,
        { db, logger, requestOptions: EXTRACTOR_REQUEST_OPTIONS },
      )
      logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
      return async ({ settings }) => {
        const candidates = await getRealEstateCandidates(db, LAP_CANDIDATE_LIMIT)
        return {
          dryRun: `would call Groq to extract ${candidates.length} real estate listings this lap`,
          run: () =>
            runRealEstateExtraction({ groq, db, logger }, candidates, settings['extract_real_estate.batch_size']),
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
