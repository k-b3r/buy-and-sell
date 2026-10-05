// Public API of the catalog module: products (extraction from listings,
// enrichment, categories, dedup/merge, model-code mismatch detection) and the
// catalog dashboard queries. Only what callers outside this folder use;
// everything else is internal (enforced by dependency-cruiser).
export { runCategoryBackfill } from './category-backfill'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
export {
  findOrCreateProduct,
  getCategoryBackfillCandidates,
  getEnrichmentCandidates,
  getExtractionCandidates,
  getSubCategoryBackfillCandidates,
  mergeDuplicateProduct,
  updateListingProductIds,
} from './product-storage'
export { CANONICAL_BASE_MODEL, normalizeBaseModel, normalizeVariantTier } from './products'
export { getProductDetail, getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './queries'
export { getProductsNeedingReview, markProductReviewed } from './review-queue'
export { runProductEnrichment } from './run-enrichment'
export { runSubCategoryBackfill } from './sub-category-backfill'
export type { ExtractionClients } from './run-extraction'
export { runProductExtraction } from './run-extraction'
