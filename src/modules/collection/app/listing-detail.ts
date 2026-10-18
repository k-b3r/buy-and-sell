import type { QueryClient } from '../../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../../platform/rows'
import type { ComparableListing, ListingPriceReview } from '../../pricing'
import {
  computeListingDiscount,
  getComparableListings,
  getPeerMedianPrice,
  getSoldComparablePrice,
  isPriceInvalidated,
  toPriceReview,
} from '../../pricing'
import { getListingDetailRow, getSiblingMedianRow } from '../store/dashboard'

export interface ListingDetail {
  id: string
  title: string
  price_amount: number | null
  price_currency: string | null
  description: string | null
  condition: string | null
  location_city: string | null
  listed_at: string | null
  last_seen_at: string | null
  photo_urls: string[]
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  verification_reasoning: string | null
  recent_sales: ComparableListing[]
  similar_listings: ComparableListing[]
}

export async function getListingDetail(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  const [row, medianRow] = await Promise.all([getListingDetailRow(db, listingId), getSiblingMedianRow(db, listingId)])
  if (!row) return null

  const photoUrls = resolvePhotoUrls(row.stored_photo_urls, row.primary_photo_url)

  const rawMedian = medianRow ? toNullableNumber(medianRow.raw_median_price) : null
  const discount = medianRow
    ? computeListingDiscount(
        row.price_amount,
        medianRow.raw_median_price,
        medianRow.clean_median_price,
        medianRow.sample_size,
      )
    : { discountPercent: null, referencePrice: null }

  const priceAmount = toNullableNumber(row.price_amount)

  // Evidence panel: only populated when the tier's own min-sample threshold
  // (MIN_PEER_SAMPLE, n>=3, for both) is met - same
  // bar /deals uses to call something a real tier, so this page never shows
  // weaker evidence than what would've qualified the listing there.
  const productId = toNullableNumber(row.product_id)
  let recentSales: ComparableListing[] = []
  let similarListings: ComparableListing[] = []
  if (productId !== null) {
    const [soldComp, peerMedian, salesRows, similarRows] = await Promise.all([
      getSoldComparablePrice(db, productId),
      getPeerMedianPrice(db, productId),
      getComparableListings(db, { productId, excludeListingId: listingId, sold: true }),
      getComparableListings(db, { productId, excludeListingId: listingId, sold: false }),
    ])
    if (soldComp) recentSales = salesRows
    if (peerMedian) similarListings = similarRows
  }

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: priceAmount !== null && isPriceInvalidated(priceAmount, rawMedian) ? null : priceAmount,
    price_currency: row.price_currency as string | null,
    description: row.description as string | null,
    condition: row.condition as string | null,
    location_city: row.location_city as string | null,
    listed_at: toIsoOrNull(row.listed_at),
    last_seen_at: toIsoOrNull(row.last_seen_at),
    photo_urls: photoUrls,
    product_id: row.product_id as number | null,
    base_model: row.base_model as string | null,
    variant_tier: row.variant_tier as string | null,
    sold_at: toIsoOrNull(row.sold_at),
    price_review: toPriceReview(row),
    discount_percent: discount.discountPercent,
    reference_price: discount.referencePrice,
    is_saved: row.is_saved as boolean,
    verification_reasoning: row.verification_reasoning as string | null,
    recent_sales: recentSales,
    similar_listings: similarListings,
  }
}
