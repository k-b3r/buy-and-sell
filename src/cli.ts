import { existsSync } from 'node:fs'
import { launchBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { autoApprove } from './review'
import { createDbPool } from './db'

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const query = args[0] ?? 'headphones'
  const maxItemsArg = args[1]
  let maxItems: number | undefined
  if (maxItemsArg !== undefined) {
    const parsed = Number(maxItemsArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid maxItems argument: "${maxItemsArg}"`)
    }
    maxItems = parsed
  }

  const logger = createLogger('data/collector.log')
  const { page, close } = await launchBrowser()
  const driver = createBrowserDriver(page)

  const dbUrl = process.env.DATABASE_URL
  const pool = dbUrl ? createDbPool(dbUrl) : undefined
  if (pool) {
    logger.info('database configured, listings will be upserted to Postgres')
  } else {
    logger.warn('no DATABASE_URL set, skipping database writes (JSONL only)')
  }

  try {
    await runCollection(
      driver,
      logger,
      autoApprove,
      process.stdin,
      process.stdout,
      {
        query,
        outputPath: 'data/listings.jsonl',
        softWallTimeoutMs: 5000,
        maxItems,
      },
      pool,
    )
  } finally {
    await close()
    if (pool) await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
