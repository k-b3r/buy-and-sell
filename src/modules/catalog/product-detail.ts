import type { QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'
import type { DiscountBand, ListingPriceReview } from '../pricing'
import {
  computeListingDiscount,
  computeMedians,
  computeRepostIds,
  isPriceInvalidated,
  NEW_PRICE_LATERAL,
  peerListingSql,
  resolveSecondhandPrice,
  SECONDHAND_PRICE_LATERAL,
  summarizeDiscounts,
  toPriceReview,
} from '../pricing'
import { exclusionReason } from './product-list'

export interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  listed_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  // Shares its normalized title with another listing of this product
  // (pricing's computeRepostIds over the full set, before any dashboard
  // filtering or paging).
  is_repost: boolean
  // The model's own reasoning for why this exact listing cleared the
  // verification gate (discount-verification.ts's VerificationOutcome,
  // 'verified' case) - null for any listing that never got a verified
  // discount_notifications row, not just an unflagged one.
  verification_reasoning: string | null
}

interface ProductEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
}

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
  // Run alongside productResult, not after it - listingsResult only needs
  // productId, not anything from the product row, so there's no reason to
  // pay two round trips back-to-back.
  const [productResult, listingsResult] = await Promise.all([
    db.query(
      `SELECT p.id, p.base_model, p.variant_tier, p.price_lookup_excluded, p.price_lookup_excluded_reason,
              np.price_low as new_price_low, np.price_high as new_price_high,
              up.price_low as used_price_low, up.price_high as used_price_high, up.source as used_price_source,
              e.description as enrichment_description, e.value_drivers as enrichment_value_drivers,
              e.has_trained_price_knowledge as enrichment_has_trained_price_knowledge,
              e.trained_price_low as enrichment_trained_price_low,
              e.trained_price_high as enrichment_trained_price_high,
              e.trained_price_currency as enrichment_trained_price_currency,
              e.model as enrichment_model, e.checked_at as enrichment_checked_at
       FROM products p
       ${NEW_PRICE_LATERAL}
       ${SECONDHAND_PRICE_LATERAL}
       LEFT JOIN product_enrichment e ON e.product_id = p.id
       WHERE p.id = $1`,
      [productId],
    ),
    db.query(
      `SELECT l.id, l.title, l.price_amount, l.primary_photo_url, l.stored_photo_urls, l.condition, l.sold_at, l.listed_at,
              ${peerListingSql('l')} AS is_peer,
              pr.is_negotiable as price_review_is_negotiable,
              pr.price_low as price_review_low, pr.price_high as price_review_high,
              sv.listing_id IS NOT NULL as is_saved,
              dn.verification_reasoning
       FROM listings l
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
       LEFT JOIN discount_notifications dn ON dn.listing_id = l.id AND dn.verified_at IS NOT NULL
       WHERE l.product_id = $1
       ORDER BY l.title`,
      [productId],
    ),
  ])
  const productRow = (productResult.rows as Record<string, unknown>[])[0]
  if (!productRow) return null

  const enrichment: ProductEnrichment | null =
    productRow.enrichment_checked_at != null
      ? {
          description: productRow.enrichment_description as string,
          value_drivers: productRow.enrichment_value_drivers as string,
          has_trained_price_knowledge: productRow.enrichment_has_trained_price_knowledge as boolean,
          trained_price_low: toNullableNumber(productRow.enrichment_trained_price_low),
          trained_price_high: toNullableNumber(productRow.enrichment_trained_price_high),
          trained_price_currency: productRow.enrichment_trained_price_currency as string | null,
          model: productRow.enrichment_model as string,
          checked_at: toIsoOrNull(productRow.enrichment_checked_at) as string,
        }
      : null

  const rawListings = (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: toNullableNumber(r.price_amount),
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    condition: r.condition as string | null,
    sold_at: toIsoOrNull(r.sold_at),
    listed_at: toIsoOrNull(r.listed_at),
    price_review: toPriceReview(r),
    is_saved: r.is_saved as boolean,
    verification_reasoning: r.verification_reasoning as string | null,
  }))
  const peerPrices = (listingsResult.rows as Record<string, unknown>[])
    .filter((r) => r.is_peer === true)
    .map((r) => toNullableNumber(r.price_amount))

  // price_lookup_excluded products (real_estate/too_generic/etc) bundle
  // unrelated real items under one fake "product" - a median across them is
  // meaningless. Forcing an empty price set here makes computeListingDiscount
  // return null for every listing (below MIN_PEER_SAMPLE), same effect as
  // DISCOUNT_SUMMARY_LATERAL's exclusion on the products-list page. Confirmed
  // live 2026-08-23: navigating directly to an excluded product's detail page
  // still showed 6 fake discount badges before this fix.
  const { rawMedian, cleanMedian, sampleSize } = computeMedians(productRow.price_lookup_excluded ? [] : peerPrices)

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
    { low: productRow.used_price_low, high: productRow.used_price_high, source: productRow.used_price_source },
    {
      known: productRow.enrichment_has_trained_price_knowledge,
      low: productRow.enrichment_trained_price_low,
      high: productRow.enrichment_trained_price_high,
    },
  )

  return {
    id: productRow.id as number,
    base_model: productRow.base_model as string,
    variant_tier: productRow.variant_tier as string | null,
    new_price_low: toNullableNumber(productRow.new_price_low),
    new_price_high: toNullableNumber(productRow.new_price_high),
    secondhand_price_low: secondhand.low,
    secondhand_price_high: secondhand.high,
    secondhand_price_source: secondhand.source,
    best_discount_percent: discountSummary.bestDiscountPercent,
    discounted_listing_count: discountSummary.discountedListingCount,
    discount_bands: discountSummary.bands,
    pricing_excluded_reason: exclusionReason(productRow),
    enrichment,
    listings,
  }
}
