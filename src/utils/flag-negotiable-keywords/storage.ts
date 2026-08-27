import type { DbClient } from '../../storage'

export interface NegotiableKeywordCandidate {
  id: string
  title: string
  description: string | null
}

// Backfill's candidate set: every listing not already flagged negotiable -
// includes ones with no listing_price_review row at all, and ones an LLM
// review already looked at but read as false (a keyword hit here can still
// upgrade that, see enrich-listing-prices/storage.ts's upsertKeywordNegotiable;
// it never downgrades). Deliberately not limited to price-outlier listings
// the way enrich-listing-prices' candidate query is - the whole point is to
// catch "nego" on a normally-priced listing too.
export async function getNegotiableKeywordCandidates(db: DbClient): Promise<NegotiableKeywordCandidate[]> {
  const result = (await db.query(
    `SELECT l.id, l.title, l.description
     FROM listings l
     WHERE NOT EXISTS (
       SELECT 1 FROM listing_price_review pr WHERE pr.listing_id = l.id AND pr.is_negotiable = true
     )`,
    [],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: r.description as string | null,
  }))
}
