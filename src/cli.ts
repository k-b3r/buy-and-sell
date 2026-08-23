import { existsSync } from 'node:fs'
import { launchBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { autoApprove } from './review'
import { createDbPool } from './db'
import { createR2ImageStore } from './images'
import { checkTunnelAlive } from './tunnel'

// Motivated-seller phrasing — these skew toward underpriced/urgent listings,
// the actual "buy-and-sell opportunity" signal this project is after, more
// than a plain product-name search does.
export const MOTIVATED_SELLER_KEYWORDS = [
  'rush sale',
  'moving out',
  'preloved',
  'slightly used',
  'barely used',
  'decluttering',
  'upgrade',
  'for disposal',
]

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const cycle = args.includes('--cycle')
  const rest = args.filter((arg) => arg !== '--cycle')
  const queries = cycle ? MOTIVATED_SELLER_KEYWORDS : [rest[0] ?? 'headphones']
  const maxItemsArg = rest[cycle ? 0 : 1]
  let maxItems: number | undefined
  if (maxItemsArg !== undefined) {
    const parsed = Number(maxItemsArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid maxItems argument: "${maxItemsArg}"`)
    }
    maxItems = parsed
  }

  const daysSinceListedArg = rest[cycle ? 1 : 2]
  let daysSinceListed: number | undefined
  if (daysSinceListedArg !== undefined) {
    const parsed = Number(daysSinceListedArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid daysSinceListed argument: "${daysSinceListedArg}"`)
    }
    daysSinceListed = parsed
  }

  const logger = createLogger('data/collector.log')

  const socksProxy = process.env.SOCKS_PROXY
  if (socksProxy) {
    const alive = await checkTunnelAlive(socksProxy)
    if (!alive) {
      logger.error(
        `SOCKS_PROXY is set to ${socksProxy} but the tunnel isn't reachable — start the laptop-side ssh -R tunnel before running collect`,
      )
      process.exit(1)
    }
    logger.info(`laptop tunnel confirmed alive via ${socksProxy}`)
  }

  const { page, close } = await launchBrowser({ socksProxy })
  const driver = createBrowserDriver(page)

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — Postgres is the collector\'s only persistence now')
  const pool = createDbPool(dbUrl)

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  const r2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE_URL
  const imageStore = r2Configured
    ? createR2ImageStore({
        accountId: R2_ACCOUNT_ID,
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_KEY,
        bucket: R2_BUCKET_NAME,
        publicBaseUrl: R2_PUBLIC_BASE_URL,
      })
    : undefined
  if (imageStore) {
    logger.info('R2 configured, photo carousels will be downloaded and re-hosted')
  } else {
    logger.warn('R2 not configured, skipping photo download (signed CDN URLs will expire)')
  }

  if (cycle) {
    logger.info(
      `--cycle: looping indefinitely through ${queries.length} motivated-seller keywords, maxItems=${maxItems ?? '(unset)'} each — Ctrl+C to stop`,
    )
  }

  try {
    let lap = 1
    do {
      if (cycle) logger.info(`--cycle: lap ${lap} starting`)
      for (const query of queries) {
        await runCollection(
          driver,
          logger,
          autoApprove,
          process.stdin,
          process.stdout,
          {
            query,
            softWallTimeoutMs: 5000,
            maxItems,
            daysSinceListed,
          },
          pool,
          imageStore,
        )
      }
      lap++
    } while (cycle)
  } finally {
    await close()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
