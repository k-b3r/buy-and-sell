import type { QueryClient } from '../../platform/storage'
import { LOOKUP_OUTCOME_REASONS } from './exclusion'

export interface ExclusionReasonCount {
  reason: string
  count: number
  // true: a failed price search, so including the product retries the lookup.
  retry: boolean
}

// Excluded view's reason groups, biggest first.
export async function getExclusionSummary(db: QueryClient): Promise<ExclusionReasonCount[]> {
  const result = (await db.query(
    `SELECT COALESCE(price_lookup_excluded_reason, 'unknown') AS reason, count(*)::int AS count,
            COALESCE(price_lookup_excluded_reason = ANY($1), false) AS retry
     FROM products WHERE price_lookup_excluded
     GROUP BY 1, 3 ORDER BY 2 DESC, 1`,
    [[...LOOKUP_OUTCOME_REASONS]],
  )) as { rows: ExclusionReasonCount[] }
  return result.rows
}

export interface ExcludedProduct {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
}

const EXCLUDED_PAGE_SIZE = 50

// One reason's excluded products, most listings first: the ones whose
// missing price hides the most.
export async function getExcludedProducts(
  db: QueryClient,
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, count(l.id)::int AS listing_count
     FROM products p LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded AND COALESCE(p.price_lookup_excluded_reason, 'unknown') = $1
     GROUP BY p.id ORDER BY listing_count DESC, p.base_model
     LIMIT $2 OFFSET $3`,
    [reason, options.limit ?? EXCLUDED_PAGE_SIZE, options.offset ?? 0],
  )) as { rows: ExcludedProduct[] }
  return result.rows
}
