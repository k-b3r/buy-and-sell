import { launchBrowser, createBrowserDriver } from '../../domains/marketplace'
import { runCollection } from '../../run'
import { createLogger } from '../../platform/logger'
import { autoApprove } from '../../platform/review'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile, realDelay, isTestRun, writePidFile } from '../../platform/utils'
import { createR2ImageStore } from '../../platform/images'
import { checkTunnelAlive } from '../../domains/marketplace'

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

// Real mode paces itself per-listing (driver.waitRandom, 4-10s) inside
// runCollection - TEST_RUN skips that entirely (no live Facebook calls at
// all), so --cycle needs its own pacing here or it would spin logging as
// fast as the loop can run.
const TEST_RUN_LOOP_DELAY_MS = 5000

async function main() {
  loadEnvFile()
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const cycle = args.includes('--cycle')
  const rest = args.filter((arg) => arg !== '--cycle')
  // No explicit query and not --cycle (the dashboard's Start button, and a
  // bare `pnpm run collect`) used to fall back to a single hardcoded
  // "headphones" test query - now runs one pass through the full
  // motivated-seller list instead, same list --cycle loops forever through.
  // An explicit single query (e.g. `pnpm run collect -- "gaming chair"`)
  // still overrides it exactly as before.
  const queries = cycle || rest[0] === undefined ? MOTIVATED_SELLER_KEYWORDS : [rest[0]]
  const maxItemsArg = rest[cycle ? 0 : 1]
  // run.ts's pagination loop treats an unset maxItems as "just the first
  // page" (its target defaults to whatever the first batch happened to
  // contain, not a real cap) - confirmed live 2026-08-28: every run.ts
  // caller here (manual `pnpm run collect` with no args, and the
  // dashboard's Start button, which spawns with zero args) hit exactly that
  // and silently never paginated past page 1. DEFAULT_MAX_ITEMS gives every
  // no-args run a real per-query target instead.
  const DEFAULT_MAX_ITEMS = 100
  let maxItems: number = DEFAULT_MAX_ITEMS
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
  writePidFile('data/collector.pid')

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
      `--cycle: looping indefinitely through ${queries.length} motivated-seller keywords, maxItems=${maxItems} each — Ctrl+C to stop`,
    )
  }

  try {
    let lap = 1
    do {
      if (cycle) logger.info(`--cycle: lap ${lap} starting`)
      for (const query of queries) {
        if (isTestRun()) {
          logger.info(`TEST_RUN: marketplace will call Facebook Marketplace to collect for query "${query}"`)
        } else {
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
      }
      if (cycle && isTestRun()) await realDelay(TEST_RUN_LOOP_DELAY_MS)
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
