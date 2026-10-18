import type { QueryClient } from '../../platform/storage'
import type { DiscountBand } from '../pricing'
import {
  computeListingDiscount,
  computeMedians,
  computeRepostIds,
  isPriceInvalidated,
  resolveSecondhandPrice,
  summarizeDiscounts,
} from '../pricing'
import type { ProductEnrichment, ProductListingSummary } from './types'
import { getProductDetailRows } from './store/product-detail'

export interface ProductDetail {
  id: number
  base_model: string
  variant_tier: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
  pricing_excluded_reason: string | null
  enrichment: ProductEnrichment | null
  listings: ProductListingSummary[]
}

export async function getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  const rows = await getProductDetailRows(db, productId)
  if (!rows) return null
  const { product } = rows

  const rawListings = rows.listings.map(({ is_peer: _isPeer, ...listing }) => listing)
  const peerPrices = rows.listings.filter((l) => l.is_peer).map((l) => l.price_amount)

  // price_lookup_excluded products (real_estate/too_generic/etc) bundle
  // unrelated real items under one fake "product" - a median across them is
  // meaningless. Forcing an empty price set here makes computeListingDiscount
  // return null for every listing (below MIN_PEER_SAMPLE), same effect as
  // DISCOUNT_SUMMARY_LATERAL's exclusion on the products-list page. Confirmed
  // live 2026-08-23: navigating directly to an excluded product's detail page
  // still showed 6 fake discount badges before this fix.
  const { rawMedian, cleanMedian, sampleSize } = computeMedians(product.price_lookup_excluded ? [] : peerPrices)

  const repostIds = computeRepostIds(rawListings)
  const listings = rawListings.map((l) => {
    const discount = computeListingDiscount(l.price_amount, rawMedian, cleanMedian, sampleSize)
    const priceAmount = l.price_amount !== null && isPriceInvalidated(l.price_amount, rawMedian) ? null : l.price_amount
    return {
      ...l,
      price_amount: priceAmount,
      discount_percent: discount.discountPercent,
      reference_price: discount.referencePrice,
      is_repost: repostIds.has(l.id),
    }
  })

  const discountSummary = summarizeDiscounts(listings.map((l) => l.discount_percent))

  const secondhand = resolveSecondhandPrice(
    { low: product.used_price_low, high: product.used_price_high, source: product.used_price_source },
    { known: product.has_trained_price_knowledge, low: product.trained_price_low, high: product.trained_price_high },
  )

  return {
    id: product.id,
    base_model: product.base_model,
    variant_tier: product.variant_tier,
    new_price_low: product.new_price_low,
    new_price_high: product.new_price_high,
    secondhand_price_low: secondhand.low,
    secondhand_price_high: secondhand.high,
    secondhand_price_source: secondhand.source,
    best_discount_percent: discountSummary.bestDiscountPercent,
    discounted_listing_count: discountSummary.discountedListingCount,
    discount_bands: discountSummary.bands,
    pricing_excluded_reason: product.pricing_excluded_reason,
    enrichment: product.enrichment,
    listings,
  }
}
