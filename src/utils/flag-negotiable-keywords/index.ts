import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/utils'
import type { NegotiableKeywordCandidate } from './storage'
import { getNegotiableKeywordCandidates } from './storage'
import { upsertKeywordNegotiable } from '../../workers/enrich-listing-prices/storage'
import { matchesNegotiableKeyword } from '../../domains/marketplace'

// One-off/rerunnable sweep over EXISTING listings for the negotiability
// keyword scan that cli/storage.ts's upsertListing and check-listings/storage.ts's
// refreshListingFields now run automatically going forward (see
// enrich-listing-prices/storage.ts's flagNegotiableFromKeywords) - this
// covers everything collected before that wiring existed. Deterministic
// pattern match, no LLM call, so safe to run against the whole table in one pass.
export async function runFlagNegotiableKeywords(
  db: DbClient,
  logger: Logger,
  candidates: NegotiableKeywordCandidate[],
): Promise<number> {
  logger.info(`${candidates.length} listings to scan for negotiability keywords`)

  let flagged = 0
  for (const candidate of candidates) {
    const matched = matchesNegotiableKeyword(candidate.title, candidate.description)
    if (!matched) continue
    await upsertKeywordNegotiable(db, candidate.id, matched)
    flagged += 1
    logger.info(`listing ${candidate.id} flagged negotiable (matched "${matched}")`)
  }

  logger.info(`flagged ${flagged} of ${candidates.length} listings as negotiable`)
  return flagged
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — flag-negotiable-keywords requires Postgres')

  const logger = createLogger('data/flag-negotiable-keywords.log')
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getNegotiableKeywordCandidates(pool)
    await runFlagNegotiableKeywords(pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('flag-negotiable-keywords complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
