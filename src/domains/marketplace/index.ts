// Public API of the marketplace domain: only what callers outside this folder use.
export type { EnrichmentCandidate } from './enrichment'
export { ENRICHMENT_RESPONSE_SCHEMA, buildEnrichmentPrompt } from './enrichment'
export { deriveTargetBaseModel, findModelCodeMismatches } from './model-mismatch'
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
