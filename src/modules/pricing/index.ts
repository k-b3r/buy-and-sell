// Public API of the pricing module: its dashboard queries, plus the shared
// price rules (placeholder/outlier checks, clean median, discount, price
// laterals) that catalog and collection queries build on. Everything else is
// internal (enforced by dependency-cruiser).
export type { DiscountBand, ListingPriceReview } from './price-rules'
export {
  computeListingDiscount,
  computeMedians,
  DISCOUNT_SUMMARY_LATERAL,
  isPlaceholderPrice,
  isPriceInvalidated,
  NEW_PRICE_LATERAL,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
  resolveSecondhandPrice,
  SECONDHAND_PRICE_LATERAL,
  summarizeDiscounts,
  toDiscountBands,
  toPriceReview,
} from './price-rules'
export { getDeals } from './deals'
export type { ComparableListing } from './queries'
export {
  getComparableListings,
  getDiscountNotifications,
  getPeerMedianPrice,
  getSoldComparablePrice,
  getUnreadDiscountNotificationCount,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
  setManualPrice,
} from './queries'
