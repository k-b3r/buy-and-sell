import { fileURLToPath } from 'node:url'
import { launchBrowserDriver } from '../../modules/collection/browser'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { secretsFromEnv } from '../../platform/redact'
import { acquireBrowserLock, releaseBrowserLock, BROWSER_LOCK_PATH } from '../../platform/browserLock'
import {
  createListingPhotos,
  getCheckListingsCandidates,
  resolveProxy,
  runCheckListings,
} from '../../modules/collection'
import { createR2ImageStore, defaultCompressImage, defaultFetchBytes } from '../../platform/images'

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — check-listings requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not fully configured in .env — check-listings needs to be able to delete photos')
  }

  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const limitArg = args[0]
  let explicitLimit: number | undefined
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    explicitLimit = parsed
  }

  await runWorker({
    name: 'check-listings',
    databaseUrl: dbUrl,
    secrets: secretsFromEnv(process.env),
    testRun: isTestRun(process.env),
    settingKeys: [
      'check_listings.loop_delay_ms',
      'check_listings.limit_default',
      'check_listings.soft_wall_timeout_ms',
      'check_listings.pacing_min_ms',
      'check_listings.pacing_max_ms',
      'check_listings.re_recheck_min_days',
    ],
    loopDelayKey: 'check_listings.loop_delay_ms',
    setup: async ({ logger, db }) => {
      const photos = createListingPhotos({
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

      // Opt-in, same as collect: no WEBSHARE_PROXY/SOCKS_PROXY at all means a
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

      return async ({ settings }) => {
        const limit = explicitLimit ?? settings['check_listings.limit_default']
        const candidates = await getCheckListingsCandidates(db, limit, settings['check_listings.re_recheck_min_days'])
        return {
          dryRun: `marketplace will call Facebook to check ${candidates.length} listings`,
          run: async () => {
            if (candidates.length === 0) {
              logger.info('lap has no candidates, skipping browser launch')
              return
            }
            // Browser only exists for the lifetime of this lap's batch, not the
            // whole process - collect (the only other browser-launching worker)
            // shares this same lock, and the VPS can't run both Chromiums at
            // once without swapping hard (see browserLock.ts). Skipped entirely
            // when there's nothing to check, same effect a min-batch gate would
            // have had, for free.
            await acquireBrowserLock(BROWSER_LOCK_PATH, logger)
            try {
              const { driver, close } = await launchBrowserDriver(proxy)
              try {
                await runCheckListings(
                  driver,
                  db,
                  photos,
                  logger,
                  candidates,
                  settings['check_listings.soft_wall_timeout_ms'],
                  settings['check_listings.pacing_min_ms'],
                  settings['check_listings.pacing_max_ms'],
                )
              } finally {
                await close()
              }
            } finally {
              releaseBrowserLock(BROWSER_LOCK_PATH)
            }
          },
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
