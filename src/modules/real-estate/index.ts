// Public API of the real-estate module: only what callers outside this folder
// use. Everything else is internal (enforced by dependency-cruiser).
export { getRealEstateCandidates } from './details'
export { EXTRACTOR_MODELS, EXTRACTOR_REQUEST_OPTIONS, runRealEstateExtraction } from './extractor'
