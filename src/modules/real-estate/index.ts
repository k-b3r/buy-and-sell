// Public API of the real-estate module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
export type {
  JsonModelClient,
  PriorPriceRow,
  RealEstateCandidate,
  RealEstateFields,
  RealEstateFilters,
  RealEstateListing,
} from './types'
export { getRealEstateCandidates, upsertRealEstateDetails } from './store/details'
export { EXTRACTOR_MODELS, EXTRACTOR_REQUEST_OPTIONS, extractRealEstateBatch } from './extractor'
export { recordRealEstatePriceChange } from './price-history'
export { getRealEstateListings } from './store/listings'
export { REAL_ESTATE_PAGE_SIZE, realEstateQuerySchema } from './schemas'
