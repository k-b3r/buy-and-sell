// Public API of the pricing module: price lookup (retail + secondhand), price
// review, discount detection/verification/notifications, its dashboard
// queries, plus the shared price rules (placeholder/outlier checks, clean
// median, discount, price laterals) that catalog and collection queries build
// on, and the generic-product check that decides what is too vague to
// price. Everything else is internal (enforced by dependency-cruiser).
export { computeMedians, isJunkPrice, isPlaceholderPrice, MIN_PEER_SAMPLE } from './domain/clean-median'
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
export type { DiscountBand, ListingPriceReview } from './types'
export {
  computeListingDiscount,
  isListingPriceNegotiable,
  isPriceInvalidated,
  resolveSecondhandPrice,
  summarizeDiscounts,
  toDiscountBands,
  toPriceReview,
} from './domain/price-rules'
export type { DealListing, DealsDiscountPolicyFloors, DealsFilters } from './types'
export { getDealListingIds, getDeals } from './app/deals'
export type { ComparableListing, PeerMedianPrice, SoldComparablePrice } from './store/comparables'
export { getComparableListings, getPeerMedianPrice, getSoldComparablePrice } from './store/comparables'
export type { DiscountNotification } from './store/discount-notifications'
export {
  getDiscountNotifications,
  getUnreadDiscountNotificationCount,
  getUnverifiedDiscountCandidates,
  insertDiscountNotifications,
  markAllDiscountNotificationsRead,
  markDiscountNotificationAttempted,
  markDiscountNotificationRead,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
} from './store/discount-notifications'
export type { NewDiscountNotification } from './types'
export { decideListingDiscount } from './app/discount-notifications'
export type { DiscountPolicyThresholds } from './types'
export { DEFAULT_DISCOUNT_POLICY } from './domain/discount-policy'
export type { DiscountVerificationCandidate, VerificationClients } from './types'
export { precheckDiscountCandidate } from './domain/discount-verification'
export { verifyDiscountCandidate } from './app/discount-verification'
export type { GenericReason } from './domain/generic-products'
export { detectGenericBaseModel, groupGenericBaseModels } from './domain/generic-products'
export type { ExcludedProduct, ExclusionReasonCount } from './store/exclusion'
export {
  applyEligibilityFromEnrichment,
  excludeFromPricing,
  getExcludedProducts,
  getExclusionSummary,
  getUnexcludedBaseModels,
  includeInPricing,
} from './store/exclusion'
export { excludeProductFromReview } from './app/exclusion'
export { LOOKUP_OUTCOME_REASONS } from './domain/exclusion-reasons'
export { excludeIneligibleCategories } from './app/ineligible-categories'
export type { ManualPrice } from './schemas'
export {
  dealsQuerySchema,
  excludedProductsQuerySchema,
  manualPriceSchema,
  notificationIdParamSchema,
  priceExclusionReasonSchema,
} from './schemas'
export { flagNegotiableFromKeywords, getPriceReviewCandidates } from './app/listing-price-review'
export { upsertListingPriceReview } from './store/listing-price-review'
export type { ListingPricesForProductCondition } from './store/price-history'
export {
  getListingPricesByProduct,
  getPriceLookupCandidates,
  getProductPricingStatus,
  insertPriceCheck,
  setManualPrice,
} from './store/price-history'
export { computePriceRangeFromPrices } from './domain/price-from-listings'
export type {
  PriceLookupCandidate,
  PriceLookupClients,
  PriceLookupDeps,
  PriceRange,
  ProductPricingResult,
} from './types'
export { ensureProductPriced, PriceLookupFailedError } from './price-lookup'
export type { TriageCandidate, TriageConfidence, TriageRow } from './types'
export { buildTriagePrompt, TRIAGE_RESPONSE_SCHEMA } from './prompts/price-triage.prompt'
export { parseTriageItem } from './domain/price-triage'
export { applyTriageVerdicts } from './app/price-triage'
export type { TriageSummaryRow } from './store/price-triage'
export { getTriageCandidates, getTriageSummary, saveTriageRows } from './store/price-triage'
export { computeRepostIds, repostKey } from './domain/repost'
export { repostKeySql } from './store/fragments'
export type { PriceReviewCandidate } from './types'
export { buildPriceReviewPrompt, PRICE_REVIEW_RESPONSE_SCHEMA } from './prompts/price-review.prompt'
