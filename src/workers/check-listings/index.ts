import { fileURLToPath } from 'node:url'
import { launchBrowserDriver } from '../../modules/collection/browser'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { runWorker } from '../../platform/worker'
import { realDelay } from '../../platform/delay'
import { secretsFromEnv } from '../../platform/redact'
import {
  createListingPhotos,
  getCheckListingsCandidates,
  getDealCheckCandidates,
  putDealsFirst,
  resolveProxy,
  runCheckListings,
} from '../../modules/collection'
import { getDealListingIds } from '../../modules/pricing'
import { r2PhotoIoFromEnv } from '../../platform/r2-photos'
import { parseLimitArg } from '../../platform/limit-arg'

// How many top-ranked /deals listings are considered for priority checking.
const DEALS_PRIORITY_POOL = 200

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — check-listings requires Postgres')

  const photoIo = r2PhotoIoFromEnv(process.env)
  if (!photoIo) throw new Error('R2 not fully configured in .env — check-listings needs to be able to delete photos')

  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const limitArg = args[0]
  const explicitLimit = parseLimitArg(limitArg)

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
      'check_listings.deals_priority_enabled',
      'check_listings.deals_recheck_min_hours',
      'discount_policy.min_profit_pesos',
      'discount_policy.min_price_pesos',
    ],
    loopDelayKey: 'check_listings.loop_delay_ms',
    setup: async ({ logger, db }) => {
      const photos = createListingPhotos({ ...photoIo, logger })

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
        const backlog = await getCheckListingsCandidates(db, limit, settings['check_listings.re_recheck_min_days'])
        let candidates = backlog
        if (settings['check_listings.deals_priority_enabled'] >= 1) {
          const dealIds = await getDealListingIds(
            db,
            {
              minProfitPesos: settings['discount_policy.min_profit_pesos'],
              minPricePesos: settings['discount_policy.min_price_pesos'],
            },
            DEALS_PRIORITY_POOL,
          )
          const deals = await getDealCheckCandidates(db, dealIds, settings['check_listings.deals_recheck_min_hours'])
          candidates = putDealsFirst(deals, backlog, limit)
        }
        return {
          dryRun: `would call Facebook to check ${candidates.length} listings`,
          run: async () => {
            if (candidates.length === 0) {
              logger.info('lap has no candidates, skipping browser launch')
              return
            }
            // Browser only exists for the lifetime of this lap's batch, not the
            // whole process. Skipped entirely when there's nothing to check.
            const { driver, close } = await launchBrowserDriver(proxy)
            try {
              await runCheckListings({ driver, db, photos, logger, delay: realDelay }, candidates, {
                softWallTimeoutMs: settings['check_listings.soft_wall_timeout_ms'],
                pacingMinMs: settings['check_listings.pacing_min_ms'],
                pacingMaxMs: settings['check_listings.pacing_max_ms'],
              })
            } finally {
              await close()
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
