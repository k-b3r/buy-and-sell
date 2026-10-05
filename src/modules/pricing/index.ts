// Public API of the pricing module: price lookup (retail + secondhand), price
// review, discount detection/verification/notifications, its dashboard
// queries, plus the shared price rules (placeholder/outlier checks, clean
// median, discount, price laterals) that catalog and collection queries build
// on, and the generic-product check that decides what is too vague to
// price. Everything else is internal (enforced by dependency-cruiser).
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
export type {
  DiscountNotification,
  DiscountPolicyThresholds,
  DiscountVerificationCandidate,
} from './discount-notifications'
export {
  decideListingDiscount,
  DEFAULT_DISCOUNT_POLICY,
  getUnverifiedDiscountCandidates,
  insertDiscountNotification,
  markDiscountNotificationAttempted,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
} from './discount-notifications'
export type { VerificationClients } from './discount-verification'
export type { GenericReason } from './generic-products'
export { detectGenericBaseModel, groupGenericBaseModels } from './generic-products'
export {
  applyEligibilityFromEnrichment,
  excludeFromPricing,
  excludeProductFromReview,
  getUnexcludedBaseModels,
} from './exclusion'
export { excludeIneligibleCategories } from './ineligible-categories'
export { precheckDiscountCandidate, verifyDiscountCandidate } from './discount-verification'
export { flagNegotiableFromKeywords, getPriceReviewCandidates, upsertListingPriceReview } from './listing-price-review'
export {
  getListingPricesByProduct,
  getPriceLookupCandidates,
  getProductPricingStatus,
  insertPriceCheck,
} from './price-history'
export { runPriceFromListings } from './price-from-listings'
export type { PriceLookupCandidate, PriceLookupClients, PriceRange, ProductPricingResult } from './price-lookup'
export { ensureProductPriced } from './price-lookup'
export { computeRepostIds, repostKey, repostKeySql } from './repost'
export type { PriceReviewCandidate } from './price-review'
export { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from './price-review'
