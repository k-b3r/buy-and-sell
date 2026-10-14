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
export type { ProductSummary } from './product-list'
export { getProductSummaries } from './product-list'
export type { CategoryWeeklySoldCounts, SubCategoryTreeEntry } from './store/product-list'
export { getSoldCountsBySubCategory, getSubCategoryTree } from './store/product-list'
export type { ProductNeedingReview } from './store/review-queue'
export { getProductsNeedingReview, markProductReviewed } from './store/review-queue'
export { runProductEnrichment } from './enrichment'
export { detectModelMismatches, reassignModelMismatches } from './model-mismatch'
export type { ExtractionClients } from './extraction'
export { runProductExtraction } from './extraction'
export type { ListingSortKey, ListingsFilters } from './schemas'
export { listingsQuerySchema, productIdParamSchema, productListQuerySchema } from './schemas'
export { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'
