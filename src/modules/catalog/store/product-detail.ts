import type { QueryClient } from '../../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../../platform/rows'
import type { ListingPriceReview } from '../../pricing'
import { NEW_PRICE_LATERAL, peerListingSql, SECONDHAND_PRICE_LATERAL, toPriceReview } from '../../pricing'
import { exclusionReason } from './product-list'

export interface ProductEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
}

// The used_price_* and trained_* fields stay raw: whether a looked-up used
// price or the model's trained guess wins is pricing's decision
// (resolveSecondhandPrice), made by the caller.
export interface ProductDetailRow {
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

export interface ProductDetailListingRow {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  listed_at: string | null
  price_review: ListingPriceReview | null
  is_saved: boolean
  verification_reasoning: string | null
  // Counts toward the product's peer price median (pricing's peerListingSql).
  is_peer: boolean
}

export interface ProductDetailRows {
  product: ProductDetailRow
  listings: ProductDetailListingRow[]
}

// null when the product does not exist.
export async function getProductDetailRows(db: QueryClient, productId: number): Promise<ProductDetailRows | null> {
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

  return {
    product: {
      id: productRow.id as number,
      base_model: productRow.base_model as string,
      variant_tier: productRow.variant_tier as string | null,
      price_lookup_excluded: Boolean(productRow.price_lookup_excluded),
      pricing_excluded_reason: exclusionReason(productRow),
      new_price_low: toNullableNumber(productRow.new_price_low),
      new_price_high: toNullableNumber(productRow.new_price_high),
      used_price_low: productRow.used_price_low,
      used_price_high: productRow.used_price_high,
      used_price_source: productRow.used_price_source,
      has_trained_price_knowledge: productRow.enrichment_has_trained_price_knowledge,
      trained_price_low: productRow.enrichment_trained_price_low,
      trained_price_high: productRow.enrichment_trained_price_high,
      enrichment,
    },
    listings: (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
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
      is_peer: r.is_peer === true,
    })),
  }
}
