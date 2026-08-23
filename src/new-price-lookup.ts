import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { ExaClient } from './exa'
import { createExaClient } from './exa'
import type { DbClient, NewPriceCandidate } from './db'
import { createDbPool, getNewPriceCandidates, insertPriceCheck, flagProductPriceLookupExcluded } from './db'
import {
  buildNewPriceQuery,
  buildNewPriceSystemPrompt,
  NEW_PRICE_OUTPUT_SCHEMA,
  parseNewPriceContent,
  extractNewPriceConfidence,
} from './new-price'

export type DelayFn = (ms: number) => Promise<void>
const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Each product is one independent Exa search — a failure on one (network
// blip, malformed response) is logged and skipped, not fatal to the run,
// unlike Groq/Gemini's quota errors which really do mean "stop, nothing
// else will succeed either." Exa has no per-call quota signal like that.
export async function runNewPriceLookup(
  exa: ExaClient,
  db: DbClient,
  logger: Logger,
  products: NewPriceCandidate[],
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${products.length} products to check for new-retail price`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await delay(1000)

    const product = products[i]
    const label = product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model
    const query = buildNewPriceQuery(product.base_model, product.variant_tier)
    const systemPrompt = buildNewPriceSystemPrompt(product.description, product.sibling_variants)

    let response: unknown
    try {
      response = await exa.searchStructured(query, systemPrompt, NEW_PRICE_OUTPUT_SCHEMA)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`product ${product.id} (${label}): Exa request failed (${message}), skipping`)
      continue
    }

    const price = parseNewPriceContent(response)
    if (!price) {
      // Exa itself searched and came up empty/unusable — unlike the catch
      // block above (a request failure, could be transient), this is a real
      // signal the product isn't a findable retail item. Flag it so future
      // runs don't pay for the same search again (see flag-price-ineligible.ts
      // for the manually-curated version of the same idea).
      await flagProductPriceLookupExcluded(db, product.id, 'exa_no_result')
      logger.warn(`product ${product.id} (${label}): no reliable new-retail price found, flagged and skipping`)
      continue
    }

    const confidence = extractNewPriceConfidence(response)
    if (confidence === 'low') {
      // A real price was returned, but Exa itself isn't confident in it —
      // don't let a shaky number masquerade as trusted data. Flagged with a
      // distinct reason from exa_no_result (a genuine "unpriceable" signal)
      // since this is "we got an answer, just not one worth trusting."
      await flagProductPriceLookupExcluded(db, product.id, 'exa_low_confidence')
      logger.warn(`product ${product.id} (${label}): price found but low confidence, flagged and skipping`)
      continue
    }

    // Store the full response (results, grounding/citations, costDollars),
    // not just the parsed price — free extra value for later enrichment/
    // analysis since we already paid for the search.
    await insertPriceCheck(db, product.id, price, JSON.stringify(response), 'exa_new_retail', 'New', confidence)
    logger.info(`product ${product.id} (${label}): ${price.low}-${price.high} ${price.currency} (confidence: ${confidence ?? 'unknown'})`)
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) throw new Error('EXA_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — new-price lookup requires Postgres')

  const logger = createLogger('data/new-price-lookup.log')
  const exa = createExaClient(apiKey)
  const pool = createDbPool(dbUrl)

  try {
    const products = await getNewPriceCandidates(pool)
    await runNewPriceLookup(exa, pool, logger, products)
  } finally {
    await pool.end()
  }
  logger.info('new-price lookup complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
