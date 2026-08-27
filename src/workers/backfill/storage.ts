import type { DbClient } from '../../storage/client'

export interface BackfillCandidate {
  id: string
  raw_json: Record<string, unknown>
}

export async function getBackfillCandidates(db: DbClient): Promise<BackfillCandidate[]> {
  const result = (await db.query(
    `SELECT id, raw_json FROM listings WHERE stored_photo_urls IS NULL`,
    [],
  )) as { rows: BackfillCandidate[] }
  return result.rows
}

// Reversible: a listing later confirmed still live (via a validation pass)
// can just be re-run through backfill, which overwrites this with real URLs.
export async function markListingPhotosUnavailable(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET stored_photo_urls = '[]'::jsonb WHERE id = $1`, [id])
}
