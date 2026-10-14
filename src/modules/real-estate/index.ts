// Public API of the real-estate module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
export { getRealEstateCandidates, upsertRealEstateDetails } from './store/details'
export type { RealEstateCandidate, RealEstateFields } from './extraction'
export type { JsonModelClient } from './extractor'
export { EXTRACTOR_MODELS, EXTRACTOR_REQUEST_OPTIONS, extractRealEstateBatch } from './extractor'
export type { PriorPriceRow } from './price-history'
export { recordRealEstatePriceChange } from './price-history'
export type { RealEstateFilters, RealEstateListing } from './store/listings'
export { getRealEstateListings } from './store/listings'
export { REAL_ESTATE_PAGE_SIZE, realEstateQuerySchema } from './schemas'
