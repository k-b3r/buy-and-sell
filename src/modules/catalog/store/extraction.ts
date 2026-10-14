import type { DbClient } from '../../../platform/storage'

export interface ExtractionCandidate {
  id: string
  title: string
  description: string | null
  condition: string | null
  price_amount: number | null
}

// condition/price_amount added (2026-08-31) for the inline discount check
// that now runs right after a listing gets its product_id, in the same
// per-item loop - without them, extract-products.ts would need a second
// per-listing round trip just to re-fetch what it already has here.
export async function getExtractionCandidates(db: DbClient): Promise<ExtractionCandidate[]> {
  const result = (await db.query(
    `SELECT id, title, description, condition, price_amount FROM listings WHERE product_id IS NULL`,
    [],
  )) as { rows: (ExtractionCandidate & { price_amount: string | null })[] }
  return result.rows.map((r) => ({ ...r, price_amount: r.price_amount === null ? null : Number(r.price_amount) }))
}
