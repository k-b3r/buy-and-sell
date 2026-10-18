import type { QueryClient } from '../../../platform/storage'
import { toNullableNumber } from '../../../platform/rows'
import type { ComparableListing } from '../../pricing'
import { getComparableListings, getPeerMedianPrice, getSoldComparablePrice } from '../../pricing'
import { toListingDetail } from '../domain/listing-detail'
import { getListingDetailRow, getSiblingMedianRow } from '../store/dashboard'
import type { ListingDetail } from '../types'

export async function getListingDetail(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  const [row, medianRow] = await Promise.all([getListingDetailRow(db, listingId), getSiblingMedianRow(db, listingId)])
  if (!row) return null

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

  return toListingDetail(row, medianRow, recentSales, similarListings)
}
