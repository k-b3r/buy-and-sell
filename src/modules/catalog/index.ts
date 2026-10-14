// Public API of the catalog module: products (extraction from listings,
// enrichment, categories, dedup/merge, model-code mismatch detection) and the
// catalog dashboard queries. Only what callers outside this folder use;
// everything else is internal (enforced by dependency-cruiser).
export { mergeDuplicateProducts, mergeProductVariantAliases } from './merge'
export { PRODUCT_CATEGORIES } from './products'
export { getEnrichmentCandidates } from './store/enrichment'
export { getExtractionCandidates } from './store/extraction'
export type { ListingsPage } from './listings-page'
export type { ProductDetail } from './product-detail'
export { getProductDetail } from './product-detail'
export type { CategoryWeeklySoldCounts, ProductSummary, SubCategoryTreeEntry } from './queries'
export { getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './queries'
export type { ProductNeedingReview } from './store/review-queue'
export { getProductsNeedingReview, markProductReviewed } from './store/review-queue'
export { runProductEnrichment } from './run-enrichment'
export { detectModelMismatches, reassignModelMismatches } from './run-model-mismatches'
export type { ExtractionClients } from './run-extraction'
export { runProductExtraction } from './run-extraction'
export type { ListingSortKey, ListingsFilters } from './schemas'
export { listingsQuerySchema, productIdParamSchema, productListQuerySchema } from './schemas'
export { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'
