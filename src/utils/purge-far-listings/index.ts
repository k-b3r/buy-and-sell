import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createR2ImageStore, deleteListingPhotos, type ImageStore } from '../../platform/images'
import { isWithinServiceArea } from '../../domains/marketplace'
import { deleteListing } from '../../domains/marketplace'

export interface FarListingCandidate {
  id: string
  lat: number
  lng: number
}

// One-off cleanup for listings collected before the 80km Manila service-area
// check existed (see domains/marketplace/location.ts) - covers every row
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
  imageStore: ImageStore,
  candidates: FarListingCandidate[],
): Promise<number> {
  for (const candidate of candidates) {
    await deleteListingPhotos(imageStore, logger, candidate.id)
    await deleteListing(db, candidate.id)
    logger.info(`purged listing ${candidate.id} (${candidate.lat}, ${candidate.lng})`)
  }
  logger.info(`purged ${candidates.length} listings outside the 80km Manila service area`)
  return candidates.length
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — purge-far-listings requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 env vars not set — purge-far-listings must also delete photos, refusing to run without it')
  }
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  const logger = createLogger('data/purge-far-listings.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getFarListingCandidates(pool)
    logger.info(`${candidates.length} listings found outside the 80km Manila service area`)
    await purgeFarListings(pool, logger, imageStore, candidates)
  } finally {
    await pool.end()
  }
  logger.info('purge-far-listings complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
