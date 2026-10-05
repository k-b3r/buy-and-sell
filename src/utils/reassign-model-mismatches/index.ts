import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { reassignModelMismatches } from '../../modules/catalog'

async function main(): Promise<void> {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')
  const dryRun = process.argv.includes('--dry-run')

  const logger = createLogger('data/reassign-model-mismatches.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)
  try {
    const { reassigned, skipped } = await reassignModelMismatches(pool, (line) => console.log(line), dryRun)
    logger.info(
      `${dryRun ? '[dry run] ' : ''}${reassigned} listing(s) reassigned, ${skipped} skipped (ambiguous or no matching product)`,
    )
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
