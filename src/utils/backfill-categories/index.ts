import { fileURLToPath } from 'node:url'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { loadGroqApiKeys } from '../../domains/llm-clients'
import { createGroqPool } from '../../domains/llm-clients/groq-sdk'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { getCategoryBackfillCandidates, runCategoryBackfill } from '../../modules/catalog'

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys(process.env)
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — category backfill requires Postgres')

  const logger = createLogger('data/backfill-categories.log', secretsFromEnv(process.env))
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
    logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
  )
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getCategoryBackfillCandidates(pool)
    await runCategoryBackfill({ groq, db: pool, logger }, candidates)
  } finally {
    await pool.end()
  }
  logger.info('category backfill complete')
}

// Guard so importing this module doesn't also run main() — see
// enrich-products for the same precedent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
