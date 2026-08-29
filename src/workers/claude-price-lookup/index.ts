import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { AnthropicClient } from '../../domains/llm-clients'
import { createAnthropicClient, createFallbackAnthropicClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { ClaudePriceCandidate } from '../../domains/marketplace'
import {
  buildClaudePriceQuery,
  buildClaudePriceSystemPrompt,
  CLAUDE_PRICE_OUTPUT_SCHEMA,
  parseClaudePriceResponse,
  isWideSpread,
  detectGenericBaseModel,
} from '../../domains/marketplace'
import { insertPriceCheck, getWebSearchPriceCandidates, flagProductPriceLookupExcluded } from '../../domains/marketplace/storage/pricing'

// Runs forever, not once - re-queries getWebSearchPriceCandidates every lap,
// same pattern as retail-price-lookup.ts before it. Each call spends real
// money (web search is $10/1,000 searches, plus Haiku token cost, unlike
// Gemini's old free tier) - DEFAULT_LAP_LIMIT caps spend to a bounded slice
// of the backlog per lap instead of processing however large the pending
// backlog happens to be, unattended, forever. The `--limit` CLI arg still
// overrides this for a manual one-off run.
const DEFAULT_LAP_LIMIT = 20
const LOOP_DELAY_MS = 300000

// Each product is one independent Claude call — a failure on one (network
// blip, malformed response) is logged and skipped, not fatal to the run.
export async function runClaudePriceLookup(
  anthropic: AnthropicClient,
  db: DbClient,
  logger: Logger,
  products: ClaudePriceCandidate[],
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${products.length} products to check for retail/secondhand price`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await delay(1000)

    const product = products[i]
    const label = product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model

    // Cheap text-only check before spending a paid call - same signal
    // getWebSearchPriceCandidates can't apply itself (it only knows
    // price_lookup_excluded is already false, not whether it plausibly
    // should be true).
    const generic = detectGenericBaseModel(product.base_model)
    if (generic) {
      await flagProductPriceLookupExcluded(db, product.id, generic.reason)
      logger.warn(`product ${product.id} (${label}): detected generic (${generic.reason}: "${generic.matched}"), flagged and skipping, no Claude call spent`)
      continue
    }

    const query = buildClaudePriceQuery(product.base_model, product.variant_tier)
    const systemPrompt = buildClaudePriceSystemPrompt(product.description, product.sibling_variants)

    let response: unknown
    try {
      response = await anthropic.searchStructured(query, systemPrompt, CLAUDE_PRICE_OUTPUT_SCHEMA)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`product ${product.id} (${label}): Claude request failed (${message}), skipping`)
      continue
    }

    const { retail, secondhand } = parseClaudePriceResponse(response)
    const rawResponse = JSON.stringify(response)

    // A real answer came back, but a range this wide usually means the
    // search grounded to a whole market segment, not this specific product —
    // drop that side rather than trust a meaningless range.
    const usableRetail = retail && !isWideSpread(retail) ? retail : null
    const usableSecondhand = secondhand && !isWideSpread(secondhand) ? secondhand : null
    if (retail && !usableRetail) logger.warn(`product ${product.id} (${label}): retail price range too wide (${retail.low}-${retail.high}), dropped`)
    if (secondhand && !usableSecondhand) {
      logger.warn(`product ${product.id} (${label}): secondhand price range too wide (${secondhand.low}-${secondhand.high}), dropped`)
    }

    if (!usableRetail && !usableSecondhand) {
      await flagProductPriceLookupExcluded(db, product.id, 'claude_no_result')
      logger.warn(`product ${product.id} (${label}): no reliable retail or secondhand price found, flagged and skipping`)
      continue
    }

    if (usableRetail) {
      await insertPriceCheck(db, product.id, usableRetail, rawResponse, 'web_search', 'New')
      logger.info(`product ${product.id} (${label}): retail ${usableRetail.low}-${usableRetail.high} ${usableRetail.currency}`)
    }
    if (usableSecondhand) {
      await insertPriceCheck(db, product.id, usableSecondhand, rawResponse, 'web_search', 'Used')
      logger.info(`product ${product.id} (${label}): secondhand ${usableSecondhand.low}-${usableSecondhand.high} ${usableSecondhand.currency}`)
    }
  }
}

async function main() {
  loadEnvFile()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price lookup requires Postgres')

  const limitArg = process.argv.slice(2).filter((arg) => arg !== '--')[0]
  let limit = DEFAULT_LAP_LIMIT
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    limit = parsed
  }

  const logger = createLogger('data/claude-price-lookup.log')
  writePidFile('data/claude-price-lookup.pid')

  const altApiKey = process.env.ALT_ANTHROPIC_API_KEY
  const anthropic = altApiKey
    ? createFallbackAnthropicClient([createAnthropicClient(apiKey), createAnthropicClient(altApiKey)])
    : createAnthropicClient(apiKey)
  if (altApiKey) {
    logger.info('ALT_ANTHROPIC_API_KEY configured, will fall back to it on a rate-limit error')
  }

  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs, up to ${limit} products/lap — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const pending = await getWebSearchPriceCandidates(pool)
      const products = pending.slice(0, limit)
      logger.info(`${pending.length} pending price lookup, processing ${products.length} this lap`)
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Claude web_search for retail/secondhand price-lookup on ${products.length} products this lap`)
      } else {
        await runClaudePriceLookup(anthropic, pool, logger, products)
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
