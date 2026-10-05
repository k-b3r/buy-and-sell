import type { DelayFn } from '../../platform/delay'
import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { PageDriver } from './driver'
import { extractDetailFields } from './extract/detail'
import type { BackfillCandidate } from './listings'
import { markListingPhotosUnavailable, upsertListing } from './listings'
import type { ListingPhotos } from './photos'
import { resolvePageState } from './run'

export interface PhotoBackfillIo {
  driver: PageDriver
  db: DbClient
  photos: ListingPhotos
  logger: Logger
  delay: DelayFn
}

// Re-visits each listing live (paced like a normal collection run) to pick up
// the full photo carousel and re-host it. Returns how many listings were
// skipped as likely unavailable.
export async function backfillListingPhotos(
  { driver, db, photos, logger, delay }: PhotoBackfillIo,
  candidates: BackfillCandidate[],
): Promise<number> {
  // A soft-wall that persists after refresh looks identical, from the HTML
  // alone, whether it's a real session-wide block or just one specific
  // listing that's been removed/sold and redirects anonymous visitors to
  // login. Empirically (6/6 confirmed by hand across two runs) a persisted
  // soft-wall on a detail page means the listing is gone, not a real
  // session-wide block, and dead listings legitimately cluster consecutively
  // (adjacent rows = same original collection batch = plausibly expired
  // together) — so a run of consecutive soft-walls is no longer treated as
  // evidence of a real block. Always skip and keep going; mark skipped
  // listings so they can be spot-checked/validated in a later separate pass.
  // Hard-block still fails closed immediately below — unaffected.
  let softWallSkipCount = 0

  for (const candidate of candidates) {
    const id = candidate.id
    await driver.waitRandom(4000, 10000)
    logger.info(`opening listing ${id}`)
    await driver.openListing({ id })

    const result = await resolvePageState(
      driver,
      logger,
      () => driver.getDetailHtml(),
      5000,
      (html) => Object.keys(extractDetailFields(html)).length > 0,
      delay,
    )
    if (result.status === 'stop') {
      if (result.reason === 'soft-wall-persisted') {
        softWallSkipCount += 1
        logger.warn(
          `soft-wall persisted for listing ${id} (likely removed/unavailable), marking as no-photos-available ` +
            `and skipping (${softWallSkipCount} skipped so far this run)`,
        )
        // Reversible: a listing later confirmed still live (via a validation
        // pass) can just be re-run through backfill, which overwrites this.
        await markListingPhotosUnavailable(db, id)
        continue
      }
      logger.error(`stopping backfill at listing ${id}`)
      break
    }

    const detail = extractDetailFields(result.html)
    const photoUrls = await photos.save(id, detail.listing_photos)

    const merged = { ...candidate.raw_json, ...detail, stored_photo_urls: photoUrls }
    await upsertListing(db, merged)

    logger.info(`saved ${photoUrls.length} photos for listing ${id}`)
  }

  return softWallSkipCount
}
