import { fileURLToPath } from 'node:url'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { getNegotiableKeywordCandidates, runFlagNegotiableKeywords } from '../../modules/pricing'

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — flag-negotiable-keywords requires Postgres')

  const logger = createLogger('data/flag-negotiable-keywords.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getNegotiableKeywordCandidates(pool)
    await runFlagNegotiableKeywords(pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('flag-negotiable-keywords complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
