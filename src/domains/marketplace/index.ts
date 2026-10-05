// Public API of the marketplace domain: only what callers outside this folder use.
export type { VerificationClients } from './discount-verification'
export { precheckDiscountCandidate, verifyDiscountCandidate } from './discount-verification'
export type { EnrichmentCandidate } from './enrichment'
export { ENRICHMENT_RESPONSE_SCHEMA, buildEnrichmentPrompt } from './enrichment'
export type { GenericReason } from './generic-products'
export { detectGenericBaseModel } from './generic-products'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
export { matchesNegotiableKeyword } from './negotiable-keywords'
export type { PriceLookupCandidate, PriceLookupClients, PriceRange, ProductPricingResult } from './price-lookup'
export { ensureProductPriced } from './price-lookup'
export type { PriceReviewCandidate } from './price-review'
export { PRICE_REVIEW_RESPONSE_SCHEMA, buildPriceReviewPrompt } from './price-review'
export type { CategoryBackfillCandidate, SubCategoryBackfillCandidate } from './products'
export {
  CANONICAL_BASE_MODEL,
  CATEGORY_BACKFILL_RESPONSE_SCHEMA,
  EXTRACTION_RESPONSE_SCHEMA,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
  SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA,
  buildCategoryBackfillPrompt,
  buildExtractionPrompt,
  buildSubCategoryBackfillPrompt,
  normalizeBaseModel,
  normalizeVariantTier,
} from './products'
export type {
  DiscountPolicyThresholds,
  DiscountVerificationCandidate,
  NegotiableKeywordCandidate,
} from './storage/listings'
export {
  DEFAULT_DISCOUNT_POLICY,
  checkListingDiscount,
  flagNegotiableFromKeywords,
  getNegotiableKeywordCandidates,
  getPriceReviewCandidates,
  getUnverifiedDiscountCandidates,
  markDiscountNotificationAttempted,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
  upsertKeywordNegotiable,
  upsertListingPriceReview,
} from './storage/listings'
export type { ListingPricesForProductCondition } from './storage/pricing'
export {
  getListingPricesByProduct,
  getPriceLookupCandidates,
  getProductPricingStatus,
  insertPriceCheck,
} from './storage/pricing'
export type { ExtractionCandidate } from './storage/products'
export {
  applyEligibilityFromEnrichment,
  findOrCreateProduct,
  flagPriceLookupExcluded,
  getCategoryBackfillCandidates,
  getEnrichmentCandidates,
  getExtractionCandidates,
  getSubCategoryBackfillCandidates,
  mergeDuplicateProduct,
  updateListingProductIds,
  updateProductCategories,
  updateProductSubCategories,
  upsertProductEnrichment,
} from './storage/products'
