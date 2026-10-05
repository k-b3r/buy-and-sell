// Public API of the collection module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
// browser.ts (Playwright) is deliberately absent: it is the module's second
// entry, imported by path only where a browser is launched, so a light import
// never loads the browser.
export type { PageDriver } from './driver'
export { extractDetailFields } from './extract/detail'
export type { CheckListingsCandidate } from './listings'
export {
  deleteListing,
  getBackfillCandidates,
  getCheckListingsCandidates,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
  markListingPhotosUnavailable,
  upsertListing,
} from './listings'
export { isWithinServiceArea } from './location'
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
export { resolvePageState, runCollection } from './run'
