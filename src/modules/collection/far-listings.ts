import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { ListingPhotos } from './photos'
import { deleteListing } from './listings'
import { isWithinServiceArea } from './location'

export interface FarListingCandidate {
  id: string
  lat: number
  lng: number
}

// One-off cleanup for listings collected before the 80km Manila service-area
// check existed (see location.ts) - covers every row
// regardless of flagged_removed_at/sold_at, since stray R2 photos can outlive
// either status.
export function filterFarCandidates(
  rows: { id: string; location_lat: string | number | null; location_lng: string | number | null }[],
): FarListingCandidate[] {
  return rows
    .filter((r) => r.location_lat != null && r.location_lng != null)
    .map((r) => ({ id: r.id, lat: Number(r.location_lat), lng: Number(r.location_lng) }))
    .filter((c) => !isWithinServiceArea({ location: { latitude: c.lat, longitude: c.lng } }))
}

export async function getFarListingCandidates(db: DbClient): Promise<FarListingCandidate[]> {
  const result = (await db.query(
    `SELECT id, location_lat, location_lng FROM listings WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL`,
    [],
  )) as { rows: { id: string; location_lat: string | null; location_lng: string | null }[] }
  return filterFarCandidates(result.rows)
}

export async function purgeFarListings(
  db: DbClient,
  logger: Logger,
  photos: ListingPhotos,
  candidates: FarListingCandidate[],
): Promise<number> {
  for (const candidate of candidates) {
    await photos.deleteAll(candidate.id)
    await deleteListing(db, candidate.id)
    logger.info(`purged listing ${candidate.id} (${candidate.lat}, ${candidate.lng})`)
  }
  logger.info(`purged ${candidates.length} listings outside the 80km Manila service area`)
  return candidates.length
}
