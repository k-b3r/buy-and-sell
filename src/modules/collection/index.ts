// Public API of the collection module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
// clients/browser.ts (Playwright) is deliberately absent: it is the module's second
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
export { isBrowserUnusableError } from './domain/browser-errors'
export { loadCollectKeywords, loadRealEstateKeywords } from './app/keywords'
export { planLapQueries } from './domain/lap-plan'
export { upsertListing } from './app/listings'
export { selectCheckCandidates } from './app/check-candidates'
export type { CheckListingsCandidate } from './store/listings'
export {
  getBackfillCandidates,
  getCollectedListingIds,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
} from './store/listings'
export { backfillListingPhotos, requireBackfillProxy } from './app/photo-backfill'
export { createListingPhotos } from './app/photos'
export { defaultProxyChecker, resolveProxy } from './clients/proxy'
export type { ListingDetail } from './app/listing-detail'
export { getListingDetail } from './app/listing-detail'
export type { SavedListingSummary } from './store/dashboard'
export { getListingProductId } from './store/dashboard'
export { getCollectKeywords, replaceCollectKeywords } from './store/keywords'
export { checkOneListing } from './app/recheck'
export type { GridListing } from './domain/extract-grid'
export { extractGridListings, looksLikeListing } from './domain/extract-grid'
export { extractDetailFields } from './domain/extract-detail'
export { extractCursor, extractLsd, parsePaginationResponse } from './domain/paginate'
export { isWithinServiceArea, MAX_SERVICE_RADIUS_KM } from './domain/location'
export { resolveDetailPage, resolvePageState } from './app/page-state'
