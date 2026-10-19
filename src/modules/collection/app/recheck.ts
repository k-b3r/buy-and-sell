import type { ListingPageIo } from '../types'
import { extractDetailFields } from '../domain/extract-detail'
import type { CheckListingsCandidate } from '../store/listings'
import { deleteListing, flagListingRemoved, markListingAlive, markListingSold } from '../store/listings'
import { refreshListingFields } from './listings'
import { resolveDetailPage } from './page-state'

export type CheckOneListingResult =
  { status: 'sold' } | { status: 'alive' } | { status: 'flagged' } | { status: 'removed' } | { status: 'hard-block' }

// Single-listing core, decoupled from the batch loop (the check-listings
// worker's run.ts) so it can also be driven on-demand (see
// server/routes/refresh.ts) rather than only via the scheduled
// getCheckListingsCandidates backlog. Assumes the driver has
// ALREADY navigated to this listing — pacing (waitRandom) and navigation
// (openListing) stay caller-side, since a batch run and a single on-demand
// refresh want different pacing behavior around them (the batch loop's
// human-paced delay between listings has no reason to apply to a single
// user-triggered request).
export async function checkOneListing(
  io: ListingPageIo,
  candidate: CheckListingsCandidate,
  softWallTimeoutMs = 5000,
): Promise<CheckOneListingResult> {
  const { db, photos, logger } = io
  const result = await resolveDetailPage(io, softWallTimeoutMs)

  if (result.status === 'stop') {
    if (result.reason !== 'soft-wall-persisted') {
      // Hard-block or unrecognized state — real signal of an actual
      // problem (not "removed"), fail closed same as everywhere else.
      logger.error(`stopping check-listings at listing ${candidate.id}`)
      return { status: 'hard-block' }
    }

    if (candidate.flagged_removed_at) {
      logger.info(
        `listing ${candidate.id} still soft-walled (flagged since ${candidate.flagged_removed_at}) — confirmed removed, deleting`,
      )
      await photos.deleteAll(candidate.id)
      await deleteListing(db, candidate.id)
      return { status: 'removed' }
    }

    logger.warn(`listing ${candidate.id} soft-walled, flagging for confirmation on a later run`)
    await flagListingRemoved(db, candidate.id)
    return { status: 'flagged' }
  }

  const detailFields = extractDetailFields(result.html)

  if (detailFields.is_sold === true) {
    logger.info(`listing ${candidate.id} detected as sold`)
    await markListingSold(db, candidate.id)
    return { status: 'sold' }
  }

  if (candidate.flagged_removed_at) {
    logger.info(`listing ${candidate.id} recovered — was flagged, now accessible again, clearing flag`)
  }
  // Still live — sync title/price/description/condition in case the
  // seller edited them since we first saw this listing, and re-sync photos
  // too if Facebook's own photo ids show the seller actually swapped them
  // (see refreshListingFields).
  await refreshListingFields(io, candidate.source_photo_ids, detailFields)
  await markListingAlive(db, candidate.id)
  return { status: 'alive' }
}
