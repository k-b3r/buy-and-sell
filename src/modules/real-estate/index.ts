// Public API of the real-estate module: the only file callers outside this
// folder import (enforced by dependency-cruiser).
export type { RealEstateCandidate, RealEstateFields } from './extraction'
export { REAL_ESTATE_RESPONSE_SCHEMA, buildRealEstatePrompt, normalizeRealEstateItem } from './extraction'
export { getRealEstateCandidates, upsertRealEstateDetails } from './details'
