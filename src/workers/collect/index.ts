import { launchBrowserDriver } from '../../modules/collection/browser'
import { autoApprove } from '../../platform/review'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { realDelay } from '../../platform/delay'
import { runWorkerProcess } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { acquireBrowserLock, releaseBrowserLock, BROWSER_LOCK_PATH } from '../../platform/browserLock'
import { createR2ImageStore, defaultCompressImage, defaultFetchBytes } from '../../platform/images'
import { createListingPhotos, resolveProxy, runCollection } from '../../modules/collection'
import { runCollectLaps } from './laps'

async function main() {
  loadEnvFile()
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const cycle = args.includes('--cycle')
  const rest = args.filter((arg) => arg !== '--cycle')
  // No explicit query and not --cycle (the dashboard's Start button, and a
  // bare `pnpm run collect`) used to fall back to a single hardcoded
  // "headphones" test query - now runs one pass through the full
  // motivated-seller keyword list instead (loaded fresh each lap, see
  // loadCollectKeywords), same list --cycle loops forever through. An
  // explicit single query (e.g. `pnpm run collect -- "gaming chair"`)
  // still overrides it exactly as before.
  const explicitQuery = !cycle ? rest[0] : undefined
  const maxItemsArg = rest[cycle ? 0 : 1]
  // run.ts's pagination loop treats an unset maxItems as "just the first
  // page" (its target defaults to whatever the first batch happened to
  // contain, not a real cap) - confirmed live 2026-08-28: every run.ts
  // caller here (manual `pnpm run collect` with no args, and the
  // dashboard's Start button, which spawns with zero args) hit exactly that
  // and silently never paginated past page 1. An explicit CLI arg always
  // wins; otherwise collect.max_items_default (loaded fresh each lap)
  // gives every no-args run a real per-query target instead.
  let explicitMaxItems: number | undefined
  if (maxItemsArg !== undefined) {
    const parsed = Number(maxItemsArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid maxItems argument: "${maxItemsArg}"`)
    }
    explicitMaxItems = parsed
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

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL not set in .env — Postgres is the collector's only persistence now")

  const collector = { name: 'collector', databaseUrl: dbUrl, secrets: secretsFromEnv(process.env) }
  await runWorkerProcess(collector, async ({ logger, db }) => {
    // Opt-in, same as before: no WEBSHARE_PROXY/SOCKS_PROXY at all means a
    // local run already on a residential IP, no egress check needed. Either
    // one configured means it must actually work - fail closed rather than
    // silently launching direct.
    let proxy: Awaited<ReturnType<typeof resolveProxy>>['proxy']
    if (process.env.WEBSHARE_PROXY || process.env.SOCKS_PROXY) {
      const resolution = await resolveProxy(process.env)
      if (!resolution.ok) {
        logger.error(resolution.error!)
        process.exit(1)
      }
      proxy = resolution.proxy
      logger.info(`egress confirmed via ${proxy!.source} (${proxy!.server})`)
    }

    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
    const r2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE_URL
    const photos = r2Configured
      ? createListingPhotos({
          store: createR2ImageStore({
            accountId: R2_ACCOUNT_ID,
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_KEY,
            bucket: R2_BUCKET_NAME,
            publicBaseUrl: R2_PUBLIC_BASE_URL,
          }),
          fetchBytes: defaultFetchBytes,
          compress: defaultCompressImage,
          logger,
        })
      : undefined
    if (photos) {
      logger.info('R2 configured, photo carousels will be downloaded and re-hosted')
    } else {
      logger.warn('R2 not configured, skipping photo download (signed CDN URLs will expire)')
    }

    await runCollectLaps(
      {
        db,
        logger,
        delay: realDelay,
        browserLock: {
          acquire: () => acquireBrowserLock(BROWSER_LOCK_PATH, logger),
          release: () => releaseBrowserLock(BROWSER_LOCK_PATH),
        },
        openBrowser: () => launchBrowserDriver(proxy),
        collectQuery: (driver, { query, maxItems }, settings) =>
          runCollection(
            driver,
            logger,
            autoApprove,
            process.stdin,
            process.stdout,
            {
              query,
              softWallTimeoutMs: settings['collect.soft_wall_timeout_ms'],
              pacingMinMs: settings['collect.pacing_min_ms'],
              pacingMaxMs: settings['collect.pacing_max_ms'],
              maxItems,
              daysSinceListed,
            },
            db,
            photos,
          ),
      },
      { cycle, testRun: isTestRun(process.env), explicitQuery, explicitMaxItems },
    )
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
