// Public API of the collection module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
// browser.ts (Playwright) is deliberately absent: it is the module's second
// entry, imported by path only where a browser is launched, so a light import
// never loads the browser.
export type { BrowserDriver, DriverFactory, PageDriver } from './driver'
export { isBrowserUnusableError } from './driver'
export type { LapQuery } from './keywords'
export { loadCollectKeywords, loadRealEstateKeywords, planLapQueries } from './keywords'
export {
  getBackfillCandidates,
  getCheckListingsCandidates,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
} from './listings'
export { backfillListingPhotos } from './photo-backfill'
export type { ListingPhotos } from './photos'
export { createListingPhotos } from './photos'
export type { ProxyChecker, ProxyEnv, ResolvedProxy } from './proxy'
export { defaultProxyChecker, resolveProxy } from './proxy'
export {
  getCollectKeywords,
  getListingDetail,
  getListingProductId,
  getSavedListings,
  replaceCollectKeywords,
  saveListing,
  unsaveListing,
} from './queries'
export { checkOneListing, runCheckListings } from './recheck'
export { runCollection } from './run'
