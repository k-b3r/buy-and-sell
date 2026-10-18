// Public API of the collection module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
// browser.ts (Playwright) is deliberately absent: it is the module's second
// entry, imported by path only where a browser is launched, so a light import
// never loads the browser.
export type {
  BrowserDriver,
  CollectKeyword,
  DriverFactory,
  LapQuery,
  ListingPageIo,
  ListingPhotos,
  PageDriver,
  PageIo,
  ProxyChecker,
  ProxyEnv,
  ResolvedProxy,
} from './types'
export { isBrowserUnusableError } from './driver'
export { loadCollectKeywords, loadRealEstateKeywords, planLapQueries } from './keywords'
export { upsertListing } from './listings'
export { selectCheckCandidates } from './check-candidates'
export type { CheckListingsCandidate } from './store/listings'
export {
  getBackfillCandidates,
  getCollectedListingIds,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
} from './store/listings'
export { backfillListingPhotos, requireBackfillProxy } from './photo-backfill'
export { createListingPhotos } from './photos'
export { defaultProxyChecker, resolveProxy } from './proxy'
export type { ListingDetail } from './listing-detail'
export { getListingDetail } from './listing-detail'
export type { SavedListingSummary } from './store/dashboard'
export { getListingProductId } from './store/dashboard'
export { getCollectKeywords, replaceCollectKeywords } from './store/keywords'
export { checkOneListing } from './recheck'
export type { GridListing } from './domain/extract-grid'
export { extractGridListings, looksLikeListing } from './domain/extract-grid'
export { extractDetailFields } from './domain/extract-detail'
export { extractCursor, extractLsd, parsePaginationResponse } from './domain/paginate'
export { isWithinServiceArea, MAX_SERVICE_RADIUS_KM } from './domain/location'
export { resolveDetailPage, resolvePageState } from './page-state'
