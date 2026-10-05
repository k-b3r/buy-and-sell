import type { QueryClient } from '../../platform/storage'
import { toIsoOrNull, toNullableNumber } from '../../platform/rows'
import { NEW_PRICE_LATERAL, SECONDHAND_PRICE_LATERAL } from '../pricing'

interface ProductReviewEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
  confidence: string | null
  is_specific_product: boolean | null
}

interface ProductPriceHistoryEntry {
  id: number
  kind: 'new' | 'secondhand'
  price_low: number | null
  price_high: number | null
  price_currency: string | null
  source: string
  condition: string | null
  checked_at: string
}

// Same kind split NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL use to pick the
// current winning row - reused here so a source's history bucket never
// disagrees with which bucket its "current price" came from.
function toPriceHistory(value: unknown): ProductPriceHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: Number(r.id),
      kind: (r.kind as string) === 'new' ? 'new' : 'secondhand',
      price_low: toNullableNumber(r.price_low),
      price_high: toNullableNumber(r.price_high),
      price_currency: r.price_currency as string | null,
      source: r.source as string,
      condition: r.condition as string | null,
      checked_at: toIsoOrNull(r.checked_at) as string,
    }
  })
}

export interface ProductNeedingReview {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  sample_photo_url: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  price_history: ProductPriceHistoryEntry[]
  enrichment: ProductReviewEnrichment | null
}

// price_lookup_review_status = 'needs_review' is set by
// applyEligibilityFromEnrichment (src/modules/pricing/exclusion.ts)
// when Groq's own confidence in identifying the product came back 'low' - see
// db/schema.sql's comment on the column. Never auto-resolves; this is the
// admin review page that comment says doesn't exist yet.
export async function getProductsNeedingReview(db: QueryClient): Promise<ProductNeedingReview[]> {
  const result = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category, sc.name AS sub_category,
            (SELECT COALESCE(l.stored_photo_urls->>0, l.primary_photo_url)
             FROM listings l WHERE l.product_id = p.id ORDER BY l.id LIMIT 1) AS sample_photo_url,
            np.price_low AS new_price_low, np.price_high AS new_price_high,
            up.price_low AS secondhand_price_low, up.price_high AS secondhand_price_high,
            (SELECT jsonb_agg(jsonb_build_object(
                'id', h.id,
                'kind', CASE WHEN h.source IN ('manual_new_retail', 'gemini_new_retail', 'tavily_new_retail', 'exa_new_retail', 'claude_code_new_retail') THEN 'new' ELSE 'secondhand' END,
                'price_low', h.price_low,
                'price_high', h.price_high,
                'price_currency', h.price_currency,
                'source', h.source,
                'condition', h.condition,
                'checked_at', h.checked_at
              ) ORDER BY h.checked_at DESC)
             FROM product_price_history h WHERE h.product_id = p.id) AS price_history,
            e.description, e.value_drivers, e.has_trained_price_knowledge,
            e.trained_price_low, e.trained_price_high, e.trained_price_currency,
            e.model, e.checked_at, e.confidence, e.is_specific_product
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories sc ON sc.id = p.sub_category_id
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     ${NEW_PRICE_LATERAL}
     ${SECONDHAND_PRICE_LATERAL}
     WHERE p.price_lookup_review_status = 'needs_review'
     ORDER BY p.id`,
    [],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    sub_category: r.sub_category as string | null,
    sample_photo_url: r.sample_photo_url as string | null,
    new_price_low: toNullableNumber(r.new_price_low),
    new_price_high: toNullableNumber(r.new_price_high),
    secondhand_price_low: toNullableNumber(r.secondhand_price_low),
    secondhand_price_high: toNullableNumber(r.secondhand_price_high),
    price_history: toPriceHistory(r.price_history),
    enrichment:
      r.checked_at != null
        ? {
            description: r.description as string,
            value_drivers: r.value_drivers as string,
            has_trained_price_knowledge: r.has_trained_price_knowledge as boolean,
            trained_price_low: toNullableNumber(r.trained_price_low),
            trained_price_high: toNullableNumber(r.trained_price_high),
            trained_price_currency: r.trained_price_currency as string | null,
            model: r.model as string,
            checked_at: toIsoOrNull(r.checked_at) as string,
            confidence: r.confidence as string | null,
            is_specific_product: r.is_specific_product as boolean | null,
          }
        : null,
  }))
}

// The only writer that clears price_lookup_review_status - a human looked at
// the product and it's fine as-is, no exclusion needed. Also stamps
// price_lookup_review_dismissed_at so applyEligibilityFromEnrichment (which
// reruns every enrich-products lap) doesn't flip needs_review back on next
// lap - confidence='low' on product_enrichment never changes, so without this
// stamp the same product re-flags forever.
export async function markProductReviewed(db: QueryClient, productId: number): Promise<void> {
  await db.query(
    `UPDATE products SET price_lookup_review_status = NULL, price_lookup_review_dismissed_at = now() WHERE id = $1`,
    [productId],
  )
}
