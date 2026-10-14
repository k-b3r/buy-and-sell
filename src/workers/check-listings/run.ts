import type { CheckListingsCandidate, ListingPageIo } from '../../modules/collection'
import { checkOneListing } from '../../modules/collection'

// Postgres-only, same as every other script now (see CONTEXT.md on removing
// the local JSONL file that used to double as a second source of truth) —
// safe to run at the same time as `collect`, ordinary row-level upserts/deletes.
interface RecheckTiming {
  softWallTimeoutMs: number
  pacingMinMs: number
  pacingMaxMs: number
}

export async function runCheckListings(
  io: ListingPageIo,
  candidates: CheckListingsCandidate[],
  { softWallTimeoutMs = 5000, pacingMinMs = 2000, pacingMaxMs = 4000 }: Partial<RecheckTiming> = {},
): Promise<void> {
  const { driver, logger } = io
  logger.info(`${candidates.length} listings to check`)

  for (const candidate of candidates) {
    await driver.waitRandom(pacingMinMs, pacingMaxMs)
    logger.info(`checking listing ${candidate.id}`)
    await driver.openListing({ id: candidate.id })

    const result = await checkOneListing(io, candidate, softWallTimeoutMs)
    if (result.status === 'hard-block') return
  }
}
