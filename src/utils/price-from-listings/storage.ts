import type { DbClient } from '../../storage'

export interface ListingPricesForProductCondition {
  id: number
  base_model: string
  variant_tier: string | null
  condition: string
  prices: number[]
}

// One group per (product, condition) pair, not per product — a blended range
// across conditions hides real price-relevant variance (a "Used - Fair" and
// a "New" of the same product don't belong in one range). Listings with no
// stated condition can't be assigned a tier, so they're excluded here (they
// were previously folded into a blended "probably used" range; now that a
// per-condition breakdown exists, an unlabeled listing has nowhere honest to go).
export async function getListingPricesByProduct(db: DbClient): Promise<ListingPricesForProductCondition[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, l.condition, array_agg(l.price_amount) AS prices
     FROM products p
     JOIN listings l ON l.product_id = p.id
     WHERE l.price_amount IS NOT NULL AND l.condition IS NOT NULL
     GROUP BY p.id, p.base_model, p.variant_tier, l.condition
     HAVING count(l.id) >= 2
     ORDER BY count(l.id) DESC`,
    [],
  )) as { rows: { id: number; base_model: string; variant_tier: string | null; condition: string; prices: string[] }[] }
  return result.rows.map((r) => ({
    id: r.id,
    base_model: r.base_model,
    variant_tier: r.variant_tier,
    condition: r.condition,
    prices: r.prices.map(Number),
  }))
}
