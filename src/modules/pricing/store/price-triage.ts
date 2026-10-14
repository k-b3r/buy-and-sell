import type { DbClient } from '../../../platform/storage'
import { toNullableNumber } from '../../../platform/rows'
import type { TriageCandidate, TriageRow } from '../price-triage'

const MAX_SAMPLE_TITLES = 3

// Excluded products not yet triaged, most listings first.
export async function getTriageCandidates(db: DbClient, limit: number): Promise<TriageCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category, e.description,
            COALESCE(p.price_lookup_excluded_reason, 'unknown') AS reason,
            count(l.id)::int AS listing_count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_amount) AS median_ask,
            (array_agg(l.title ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL))[1:${MAX_SAMPLE_TITLES}] AS sample_titles
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded
       AND NOT EXISTS (SELECT 1 FROM product_pricing_triage t WHERE t.product_id = p.id)
     GROUP BY p.id, c.name, e.description
     ORDER BY listing_count DESC, p.id
     LIMIT $1`,
    [limit],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    description: r.description as string | null,
    reason: r.reason as string,
    listing_count: r.listing_count as number,
    median_ask: toNullableNumber(r.median_ask),
    sample_titles: (r.sample_titles as string[] | null) ?? [],
  }))
}

// Re-triaging a product replaces its verdict and resets its applied mark.
export async function saveTriageRows(db: DbClient, rows: TriageRow[]): Promise<void> {
  for (const r of rows) {
    await db.query(
      `INSERT INTO product_pricing_triage
         (product_id, previous_reason, verdict, is_specific_product, confidence, price_low, price_high, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (product_id) DO UPDATE SET
         previous_reason = EXCLUDED.previous_reason, verdict = EXCLUDED.verdict,
         is_specific_product = EXCLUDED.is_specific_product, confidence = EXCLUDED.confidence,
         price_low = EXCLUDED.price_low, price_high = EXCLUDED.price_high, reasoning = EXCLUDED.reasoning,
         triaged_at = now(), applied_at = NULL`,
      [
        r.productId,
        r.previousReason,
        r.verdict,
        r.isSpecificProduct,
        r.confidence,
        r.priceLow,
        r.priceHigh,
        r.reasoning,
      ],
    )
  }
}

export interface TriageSummaryRow {
  previous_reason: string
  verdict: string
  confidence: string
  count: number
}

// What a review looks at before applying: verdict split per old reason.
export async function getTriageSummary(db: DbClient): Promise<TriageSummaryRow[]> {
  const result = (await db.query(
    `SELECT previous_reason, verdict, confidence, count(*)::int AS count
     FROM product_pricing_triage WHERE applied_at IS NULL
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    [],
  )) as { rows: TriageSummaryRow[] }
  return result.rows
}

// Distinct old exclusion reasons that have triage rows.
export async function getTriagedReasons(db: DbClient): Promise<string[]> {
  const result = (await db.query('SELECT DISTINCT previous_reason FROM product_pricing_triage', [])) as {
    rows: { previous_reason: string }[]
  }
  return result.rows.map((r) => r.previous_reason)
}

// Unapplied "retry" verdicts at or above minConfidenceRank (3 high, 2 medium,
// 1 low). A human's manual_review exclusion is never overturned, listed or
// not. `reasons` limits it to products whose old exclusion reason is listed;
// omitted means every reason.
export async function getRetryVerdictProductIds(
  db: DbClient,
  minConfidenceRank: number,
  reasons?: string[],
): Promise<number[]> {
  const result = (await db.query(
    `SELECT product_id FROM product_pricing_triage
     WHERE verdict = 'retry' AND applied_at IS NULL
       AND CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END >= $1
       AND previous_reason <> 'manual_review'
       AND ($2::text[] IS NULL OR previous_reason = ANY($2))
     ORDER BY product_id`,
    [minConfidenceRank, reasons ?? null],
  )) as { rows: { product_id: number }[] }
  return result.rows.map((r) => r.product_id)
}

export async function markTriageApplied(db: DbClient, productId: number): Promise<void> {
  await db.query('UPDATE product_pricing_triage SET applied_at = now() WHERE product_id = $1', [productId])
}
