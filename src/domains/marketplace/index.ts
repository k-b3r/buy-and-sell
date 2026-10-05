// Public API of the marketplace domain: only what callers outside this folder use.
// browser.ts (Playwright) is deliberately absent; import it from its own path so
// a light import never loads the browser.
export type { PageDriver } from './driver'
export type { EnrichmentCandidate } from './enrichment'
export { ENRICHMENT_RESPONSE_SCHEMA, buildEnrichmentPrompt } from './enrichment'
export { extractDetailFields } from './extract/detail'
export { extractGridListings, looksLikeListing } from './extract/grid'
export type { GenericReason } from './generic-products'
export { detectGenericBaseModel } from './generic-products'
export { MAX_SERVICE_RADIUS_KM, isWithinServiceArea } from './location'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
export { extractCursor, extractLsd, parsePaginationResponse } from './paginate'
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
export type { CheckListingsCandidate } from './storage/listings'
export {
  deleteListing,
  flagListingRemoved,
  getBackfillCandidates,
  getCheckListingsCandidates,
  getCollectedListingIds,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
  markListingAlive,
  markListingPhotosUnavailable,
  markListingSold,
  refreshListingFields,
  upsertListing,
} from './storage/listings'
export type { ExtractionCandidate } from './storage/products'
export {
  findOrCreateProduct,
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
export { detectPageState } from './wall'
