import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { ExaClient } from '../../domains/llm-clients'
import { createExaClient, createFallbackExaClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { NewPriceCandidate } from '../../domains/marketplace'
import {
  buildNewPriceQuery,
  buildNewPriceSystemPrompt,
  NEW_PRICE_OUTPUT_SCHEMA,
  parseNewPriceContent,
  extractNewPriceConfidence,
  extractNewPriceMetadata,
  isWideSpread,
  detectGenericBaseModel,
} from '../../domains/marketplace'
import { insertPriceCheck, getNewPriceCandidates, flagProductPriceLookupExcluded } from '../../domains/marketplace/storage/pricing'

// Runs forever, not once - re-queries getNewPriceCandidates every lap, same
// pattern as enrich-products.ts. Unlike the free/quota-bounded workers,
// each Exa call here costs real money (~$0.007) - DEFAULT_LAP_LIMIT caps
// spend to a bounded slice of the backlog per lap instead of processing
// however large the pending backlog happens to be, unattended, forever. The
// `--limit` CLI arg still overrides this for a manual one-off run.
const DEFAULT_LAP_LIMIT = 20
const LOOP_DELAY_MS = 300000

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

    // Cheap text-only check before spending a paid Exa call - same signal
    // getNewPriceCandidates can't apply itself (it only knows price_lookup_
    // excluded is already false, not whether it plausibly should be true).
    // A miss here just means the next lap tries it again via Exa - low
    // cost, unlike an under-flag that's never revisited.
    const generic = detectGenericBaseModel(product.base_model)
    if (generic) {
      await flagProductPriceLookupExcluded(db, product.id, generic.reason)
      logger.warn(`product ${product.id} (${label}): detected generic (${generic.reason}: "${generic.matched}"), flagged and skipping, no Exa call spent`)
      continue
    }

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

    if (isWideSpread(price)) {
      // A real answer came back, but the range itself is too wide to be one
      // product (e.g. "CPU Motherboard Bundle" returning ₱4,895-58,140) —
      // Exa grounded to a whole market segment, not a specific item.
      // Independent of confidence: Exa can report "high" per-field
      // confidence while the combined range is still meaningless.
      await flagProductPriceLookupExcluded(db, product.id, 'exa_wide_spread')
      logger.warn(`product ${product.id} (${label}): price range too wide (${price.low}-${price.high}), flagged and skipping`)
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
    const { releaseYear, isDiscontinued } = extractNewPriceMetadata(response)
    await insertPriceCheck(db, product.id, price, JSON.stringify(response), 'exa_new_retail', 'New', confidence, releaseYear, isDiscontinued)
    logger.info(`product ${product.id} (${label}): ${price.low}-${price.high} ${price.currency} (confidence: ${confidence ?? 'unknown'})`)
  }
}

async function main() {
  loadEnvFile()
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) throw new Error('EXA_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — new-price lookup requires Postgres')

  // Each search costs real money (~$0.007) unlike Groq/Gemini's free tiers —
  // an optional limit lets a manual run be capped to a small batch instead of
  // spending against the entire candidate backlog at once. Defaults to
  // DEFAULT_LAP_LIMIT when running as the unattended loop (no CLI arg given).
  const limitArg = process.argv.slice(2).filter((arg) => arg !== '--')[0]
  let limit = DEFAULT_LAP_LIMIT
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    limit = parsed
  }

  const logger = createLogger('data/retail-price-lookup.log')
  writePidFile('data/retail-price-lookup.pid')

  const altApiKey = process.env.ALT_EXA_API_KEY
  const exa = altApiKey ? createFallbackExaClient([createExaClient(apiKey), createExaClient(altApiKey)]) : createExaClient(apiKey)
  if (altApiKey) {
    logger.info('ALT_EXA_API_KEY configured, will fall back to it once the primary key runs out of credits')
  }

  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs, up to ${limit} products/lap — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const pending = await getNewPriceCandidates(pool)
      const products = pending.slice(0, limit)
      logger.info(`${pending.length} pending new-price lookup, processing ${products.length} this lap`)
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Exa for retail price-lookup on ${products.length} products this lap`)
      } else {
        await runNewPriceLookup(exa, pool, logger, products)
      }
      logger.info(`lap ${lap} complete, sleeping ${LOOP_DELAY_MS}ms`)
      lap++
      await realDelay(LOOP_DELAY_MS)
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
