import type { QueryClient } from '../../../platform/storage'
import type { DiscountBand } from '../../pricing'
import { resolveSecondhandPrice } from '../../pricing'
import type { ProductSummaryOptions } from '../store/product-list'
import { getProductSummaryRows } from '../store/product-list'

export interface ProductSummary {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  listing_count: number
  price_min: number | null
  price_max: number | null
  price_avg: number | null
  sample_photo_url: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
  // Why price lookup skips this product; null when it doesn't (BUY-36).
  pricing_excluded_reason: string | null
}

export async function getProductSummaries(
  db: QueryClient,
  options: ProductSummaryOptions = {},
): Promise<ProductSummary[]> {
  const rows = await getProductSummaryRows(db, options)
  return rows.map(
    ({
      used_price_low,
      used_price_high,
      used_price_source,
      has_trained_price_knowledge,
      trained_price_low,
      trained_price_high,
      ...row
    }) => {
      const secondhand = resolveSecondhandPrice(
        { low: used_price_low, high: used_price_high, source: used_price_source },
        { known: has_trained_price_knowledge, low: trained_price_low, high: trained_price_high },
      )
      return {
        ...row,
        secondhand_price_low: secondhand.low,
        secondhand_price_high: secondhand.high,
        secondhand_price_source: secondhand.source,
      }
    },
  )
}
