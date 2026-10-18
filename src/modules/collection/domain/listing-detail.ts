import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../../platform/rows'
import type { ComparableListing } from '../../pricing'
import { computeListingDiscount, isPriceInvalidated, toPriceReview } from '../../pricing'
import type { ListingDetail } from '../types'

type Row = Record<string, unknown>

// Maps the listing row, its sibling-median row and the already-gated evidence
// lists to the detail the dashboard shows.
export function toListingDetail(
  row: Row,
  medianRow: Row | undefined,
  recentSales: ComparableListing[],
  similarListings: ComparableListing[],
): ListingDetail {
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
