// Public API of the pricing module: price lookup (retail + secondhand), price
// review, discount detection/verification/notifications, its dashboard
// queries, plus the shared price rules (placeholder/outlier checks, clean
// median, discount, price laterals) that catalog and collection queries build
// on, and the generic-product check that decides what is too vague to
// price. Everything else is internal (enforced by dependency-cruiser).
export { computeMedians, isJunkPrice, isPlaceholderPrice } from './clean-median'
export {
  DISCOUNT_SUMMARY_LATERAL,
  medianCtes,
  NEW_PRICE_LATERAL,
  notJunkPriceSql,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
  peerListingSql,
  SECONDHAND_PRICE_LATERAL,
} from './store/fragments'
export type { DiscountBand, ListingPriceReview } from './price-rules'
export {
  computeListingDiscount,
  isListingPriceNegotiable,
  isPriceInvalidated,
  resolveSecondhandPrice,
  summarizeDiscounts,
  toDiscountBands,
  toPriceReview,
} from './price-rules'
export type { DealListing, DealsDiscountPolicyFloors, DealsFilters } from './deals'
export { getDealListingIds, getDeals } from './deals'
export type { ComparableListing, PeerMedianPrice, SoldComparablePrice } from './store/comparables'
export { getComparableListings, getPeerMedianPrice, getSoldComparablePrice } from './store/comparables'
export type { DiscountNotification, DiscountVerificationCandidate } from './store/discount-notifications'
export {
  getDiscountNotifications,
  getUnreadDiscountNotificationCount,
  getUnverifiedDiscountCandidates,
  insertDiscountNotifications,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
} from './store/discount-notifications'
export type { NewDiscountNotification } from './discount-notifications'
export { decideListingDiscount } from './discount-notifications'
export type { DiscountPolicyThresholds } from './discount-policy'
export { DEFAULT_DISCOUNT_POLICY } from './discount-policy'
export type { VerificationClients } from './discount-verification'
export type { GenericReason } from './generic-products'
export { detectGenericBaseModel, groupGenericBaseModels } from './generic-products'
export type { ExcludedProduct, ExclusionReasonCount } from './store/exclusion'
export {
  applyEligibilityFromEnrichment,
  excludeFromPricing,
  getExcludedProducts,
  getExclusionSummary,
  getUnexcludedBaseModels,
  includeInPricing,
} from './store/exclusion'
export { excludeProductFromReview } from './exclusion'
export { LOOKUP_OUTCOME_REASONS } from './exclusion-reasons'
export { excludeIneligibleCategories } from './ineligible-categories'
export type { ManualPrice } from './schemas'
export {
  dealsQuerySchema,
  excludedProductsQuerySchema,
  manualPriceSchema,
  notificationIdParamSchema,
  priceExclusionReasonSchema,
} from './schemas'
export { runVerifyDiscountNotifications } from './run-discount-verification'
export { flagNegotiableFromKeywords, getPriceReviewCandidates } from './listing-price-review'
export {
  getListingPricesByProduct,
  getPriceLookupCandidates,
  getProductPricingStatus,
  insertPriceCheck,
  setManualPrice,
} from './store/price-history'
export { runPriceFromListings } from './price-from-listings'
export type { PriceLookupCandidate, PriceLookupClients, PriceRange, ProductPricingResult } from './price-lookup'
export { ensureProductPriced, PriceLookupFailedError } from './price-lookup'
export { runPriceLookup } from './run-price-lookup'
export type { TriageCandidate, TriageConfidence, TriageRow, TriageSummaryRow } from './price-triage'
export {
  applyTriageVerdicts,
  getTriageCandidates,
  getTriageSummary,
  runPriceTriage,
  saveTriageRows,
} from './price-triage'
export { computeRepostIds, repostKey, repostKeySql } from './repost'
export type { PriceReviewCandidate } from './price-review'
export { runPriceReview } from './run-price-review'
