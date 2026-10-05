// Public API of the catalog module: products (extraction from listings,
// enrichment, categories, dedup/merge, model-code mismatch detection) and the
// catalog dashboard queries. Only what callers outside this folder use;
// everything else is internal (enforced by dependency-cruiser).
export type { EnrichmentCandidate } from './enrichment'
export { ENRICHMENT_RESPONSE_SCHEMA, buildEnrichmentPrompt } from './enrichment'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
export type { ExtractionCandidate } from './product-storage'
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
} from './product-storage'
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
export { getProductDetail, getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './queries'
export { getProductsNeedingReview, markProductReviewed } from './review-queue'
export { runProductEnrichment } from './run-enrichment'
export type { ExtractionClients } from './run-extraction'
export { runProductExtraction } from './run-extraction'
