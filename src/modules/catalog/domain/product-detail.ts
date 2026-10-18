import {
  computeListingDiscount,
  computeMedians,
  computeRepostIds,
  isPriceInvalidated,
  resolveSecondhandPrice,
  summarizeDiscounts,
} from '../../pricing'
import type { ProductDetail, ProductEnrichment, ProductListingSummary } from '../types'

// What assembleProductDetail reads from the fetched rows. The store's row
// types satisfy it structurally; the used_price_* and trained_* fields stay
// raw because pricing's resolveSecondhandPrice decides which one wins.
export interface ProductDetailSource {
  product: {
    id: number
    base_model: string
    variant_tier: string | null
    price_lookup_excluded: boolean
    pricing_excluded_reason: string | null
    new_price_low: number | null
    new_price_high: number | null
    used_price_low: unknown
    used_price_high: unknown
    used_price_source: unknown
    has_trained_price_knowledge: unknown
    trained_price_low: unknown
    trained_price_high: unknown
    enrichment: ProductEnrichment | null
  }
  listings: (Omit<ProductListingSummary, 'discount_percent' | 'reference_price' | 'is_repost'> & {
    // Counts toward the product's peer price median (pricing's peerListingSql).
    is_peer: boolean
  })[]
}

export function assembleProductDetail(rows: ProductDetailSource): ProductDetail {
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
