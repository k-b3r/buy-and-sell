// Public API of the pricing module: price lookup (retail + secondhand), price
// review, discount detection/verification/notifications, its dashboard
// queries, plus the shared price rules (placeholder/outlier checks, clean
// median, discount, price laterals) that catalog and collection queries build
// on. Everything else is internal (enforced by dependency-cruiser).
export {
  computeMedians,
  isPlaceholderPrice,
  medianCtes,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
} from './clean-median'
export type { DiscountBand, ListingPriceReview } from './price-rules'
export {
  computeListingDiscount,
  DISCOUNT_SUMMARY_LATERAL,
  isPriceInvalidated,
  NEW_PRICE_LATERAL,
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
export type { DiscountPolicyThresholds, DiscountVerificationCandidate } from './discount-notifications'
export {
  checkListingDiscount,
  DEFAULT_DISCOUNT_POLICY,
  getUnverifiedDiscountCandidates,
  markDiscountNotificationAttempted,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
} from './discount-notifications'
export type { VerificationClients } from './discount-verification'
export { precheckDiscountCandidate, verifyDiscountCandidate } from './discount-verification'
export type { NegotiableKeywordCandidate } from './listing-price-review'
export {
  flagNegotiableFromKeywords,
  getNegotiableKeywordCandidates,
  getPriceReviewCandidates,
  upsertKeywordNegotiable,
  upsertListingPriceReview,
} from './listing-price-review'
export { matchesNegotiableKeyword } from './negotiable-keywords'
export type { ListingPricesForProductCondition } from './price-history'
export {
  getListingPricesByProduct,
  getPriceLookupCandidates,
  getProductPricingStatus,
  insertPriceCheck,
} from './price-history'
export type {
  DetectGeneric,
  PriceLookupCandidate,
  PriceLookupClients,
  PriceRange,
  ProductPricingResult,
} from './price-lookup'
export { ensureProductPriced } from './price-lookup'
export { computeRepostIds, repostKey, repostKeySql } from './repost'
export type { PriceReviewCandidate } from './price-review'
export { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from './price-review'
