// Public API of the marketplace domain: only what callers outside this folder use.
// browser.ts (Playwright) is deliberately absent; import it from its own path so
// a light import never loads the browser.
export type { VerificationClients } from './discount-verification'
export { precheckDiscountCandidate, verifyDiscountCandidate } from './discount-verification'
export type { PageDriver } from './driver'
export type { EnrichmentCandidate } from './enrichment'
export { ENRICHMENT_RESPONSE_SCHEMA, buildEnrichmentPrompt } from './enrichment'
export { extractDetailFields } from './extract/detail'
export { extractGridListings, looksLikeListing } from './extract/grid'
export type { GenericReason } from './generic-products'
export { detectGenericBaseModel } from './generic-products'
export { MAX_SERVICE_RADIUS_KM, isWithinServiceArea } from './location'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
export { matchesNegotiableKeyword } from './negotiable-keywords'
export { extractCursor, extractLsd, parsePaginationResponse } from './paginate'
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
export type { ProxyChecker, ProxyEnv, ResolvedProxy } from './proxy'
export { defaultProxyChecker, resolveProxy } from './proxy'
export type { RealEstateCandidate, RealEstateFields } from './real-estate'
export { REAL_ESTATE_RESPONSE_SCHEMA, buildRealEstatePrompt, normalizeRealEstateItem } from './real-estate'
export type {
  CheckListingsCandidate,
  DiscountPolicyThresholds,
  DiscountVerificationCandidate,
  NegotiableKeywordCandidate,
} from './storage/listings'
export {
  DEFAULT_DISCOUNT_POLICY,
  checkListingDiscount,
  deleteListing,
  flagListingRemoved,
  getBackfillCandidates,
  getCheckListingsCandidates,
  getCollectedListingIds,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
  getNegotiableKeywordCandidates,
  getPriceReviewCandidates,
  getUnverifiedDiscountCandidates,
  markDiscountNotificationAttempted,
  markDiscountNotificationVerified,
  markListingAlive,
  markListingPhotosUnavailable,
  markListingSold,
  refreshListingFields,
  rejectDiscountNotification,
  upsertKeywordNegotiable,
  upsertListing,
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
export { getRealEstateCandidates, upsertRealEstateDetails } from './storage/real-estate'
export { detectPageState } from './wall'
