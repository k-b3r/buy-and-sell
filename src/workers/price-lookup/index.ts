import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../../domains/llm-clients'
import { createGeminiClient, createExaClient, createFallbackExaClient, createTavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { PriceLookupCandidate, PriceRange } from '../../domains/marketplace'
import {
  buildGeminiSecondhandPrompt,
  parseGeminiPriceResponse,
  buildExaQuery,
  buildExaSystemPrompt,
  EXA_PRICE_SCHEMA,
  parseExaPriceResponse,
  buildTavilyQuery,
  parseTavilyPriceAnswer,
  isWideSpread,
  detectGenericBaseModel,
} from '../../domains/marketplace'
import type { PriceCheckSource } from '../../domains/marketplace/storage/pricing'
import { insertPriceCheck, getPriceLookupCandidates, flagProductPriceLookupExcluded } from '../../domains/marketplace/storage/pricing'

export interface PriceLookupClients {
  gemini: GeminiClient
  exa: ExaClient
  tavily: TavilyClient
}

interface PriceLookupResult {
  price: PriceRange
  source: PriceCheckSource
  rawResponse: string
}

function productLabel(product: PriceLookupCandidate): string {
  return product.variant_tier ? `${product.base_model} (${product.variant_tier})` : product.base_model
}

function tavilyText(result: { answer: string | null; results: { content: string }[] }): string {
  return result.answer ?? result.results.map((r) => r.content).join('\n')
}

// Retail: Exa (structured, cites sources) -> Tavily (free, regex parsed).
// Per a live head-to-head against Tavily (2026-08-31, 15 real candidates,
// see discount-verification.ts's fetchFreshMarketContext comment for the
// full record): Exa cited sources and abstained honestly when it lacked
// real data, where Tavily confidently fabricated numbers with no citation
// trail.
async function lookupRetail(clients: PriceLookupClients, product: PriceLookupCandidate, logger: Logger, label: string): Promise<PriceLookupResult | null> {
  try {
    const response = await clients.exa.searchStructured(buildExaQuery('retail', product), buildExaSystemPrompt('retail', product), EXA_PRICE_SCHEMA)
    const price = parseExaPriceResponse(response)
    if (price) {
      if (!isWideSpread(price)) return { price, source: 'exa_new_retail', rawResponse: JSON.stringify(response) }
      logger.warn(`product ${product.id} (${label}): Exa retail range too wide (${price.low}-${price.high}), falling back to Tavily`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Exa retail lookup failed (${message}), falling back to Tavily`)
  }

  try {
    const result = await clients.tavily.search(buildTavilyQuery('retail', product))
    const text = tavilyText(result)
    const price = parseTavilyPriceAnswer(text)
    if (!price) return null
    if (isWideSpread(price)) {
      logger.warn(`product ${product.id} (${label}): Tavily retail range too wide (${price.low}-${price.high}), dropped`)
      return null
    }
    return { price, source: 'tavily_new_retail', rawResponse: text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Tavily retail lookup failed (${message})`)
    return null
  }
}

// Secondhand: Gemini (free, grounded) -> Exa (structured, cites sources) ->
// Tavily (free, regex parsed). Per a live 5-product Gemini-vs-Exa comparison
// (2026-08-31): Exa won retail 3/3, but Gemini won secondhand 2/3 (closer to
// independently-researched real prices) - so secondhand gets its own,
// Gemini-first chain rather than sharing retail's Exa-first one.
async function lookupSecondhand(
  clients: PriceLookupClients,
  product: PriceLookupCandidate,
  logger: Logger,
  label: string,
): Promise<PriceLookupResult | null> {
  try {
    const text = await clients.gemini.generateGroundedText(buildGeminiSecondhandPrompt(product))
    const price = parseGeminiPriceResponse(text)
    if (price) {
      if (!isWideSpread(price)) return { price, source: 'gemini_grounding', rawResponse: text }
      logger.warn(`product ${product.id} (${label}): Gemini secondhand range too wide (${price.low}-${price.high}), falling back to Exa`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Gemini secondhand lookup failed (${message}), falling back to Exa`)
  }

  try {
    const response = await clients.exa.searchStructured(
      buildExaQuery('secondhand', product),
      buildExaSystemPrompt('secondhand', product),
      EXA_PRICE_SCHEMA,
    )
    const price = parseExaPriceResponse(response)
    if (price) {
      if (!isWideSpread(price)) return { price, source: 'exa_secondhand', rawResponse: JSON.stringify(response) }
      logger.warn(`product ${product.id} (${label}): Exa secondhand range too wide (${price.low}-${price.high}), falling back to Tavily`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Exa secondhand lookup failed (${message}), falling back to Tavily`)
  }

  try {
    const result = await clients.tavily.search(buildTavilyQuery('secondhand', product))
    const text = tavilyText(result)
    const price = parseTavilyPriceAnswer(text)
    if (!price) return null
    if (isWideSpread(price)) {
      logger.warn(`product ${product.id} (${label}): Tavily secondhand range too wide (${price.low}-${price.high}), dropped`)
      return null
    }
    return { price, source: 'tavily_secondhand', rawResponse: text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Tavily secondhand lookup failed (${message})`)
    return null
  }
}

const DEFAULT_LAP_LIMIT = 20
const LOOP_DELAY_MS = 300000

// Each product is independent - a failure on one doesn't stop the lap.
export async function runPriceLookup(
  clients: PriceLookupClients,
  db: DbClient,
  logger: Logger,
  products: PriceLookupCandidate[],
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${products.length} products to check for retail/secondhand price`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await delay(1000)

    const product = products[i]
    const label = productLabel(product)

    // Cheap text-only check before spending any paid/quota call - same
    // signal getPriceLookupCandidates can't apply itself (it only knows
    // price_lookup_excluded is already false, not whether it plausibly
    // should be true).
    const generic = detectGenericBaseModel(product.base_model)
    if (generic) {
      await flagProductPriceLookupExcluded(db, product.id, generic.reason)
      logger.warn(`product ${product.id} (${label}): detected generic (${generic.reason}: "${generic.matched}"), flagged and skipping`)
      continue
    }

    const retail = await lookupRetail(clients, product, logger, label)
    const secondhand = await lookupSecondhand(clients, product, logger, label)

    if (!retail && !secondhand) {
      await flagProductPriceLookupExcluded(db, product.id, 'price_not_found')
      logger.warn(`product ${product.id} (${label}): no reliable retail or secondhand price found, flagged and skipping`)
      continue
    }

    if (retail) {
      await insertPriceCheck(db, product.id, retail.price, retail.rawResponse, retail.source, 'New')
      logger.info(`product ${product.id} (${label}): retail ${retail.price.low}-${retail.price.high} ${retail.price.currency} (${retail.source})`)
    }
    if (secondhand) {
      await insertPriceCheck(db, product.id, secondhand.price, secondhand.rawResponse, secondhand.source, 'Used')
      logger.info(
        `product ${product.id} (${label}): secondhand ${secondhand.price.low}-${secondhand.price.high} ${secondhand.price.currency} (${secondhand.source})`,
      )
    }
  }
}

async function main() {
  loadEnvFile()

  const geminiApiKey = process.env.FREE_GEMINI_API_KEY
  if (!geminiApiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const exaApiKey = process.env.EXA_API_KEY
  if (!exaApiKey) throw new Error('EXA_API_KEY not set in .env')
  const tavilyApiKey = process.env.TAVILY_API_KEY
  if (!tavilyApiKey) throw new Error('TAVILY_API_KEY not set in .env')
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

  const logger = createLogger('data/price-lookup.log')
  writePidFile('data/price-lookup.pid')

  // Exa is now the primary source for both retail and secondhand - its
  // credits ran out mid-investigation once already (2026-08-31, real 402),
  // so a second key is worth having on hand now that it's no longer just a
  // fallback-of-a-fallback.
  const exaClients = [createExaClient(exaApiKey)]
  const altExaApiKey = process.env.ALT_EXA_API_KEY
  if (altExaApiKey) {
    exaClients.push(createExaClient(altExaApiKey))
    logger.info("ALT_EXA_API_KEY configured, will fall back to it once the primary key's credits are exhausted")
  }

  const clients: PriceLookupClients = {
    // Free tier only (per direct instruction: no paid Gemini in the app).
    // Its real ~20 req/day/key wall is Google's own enforcement (a 429, no
    // client-side cap needed like the paid-tier grounding case) - a quota
    // hit here just falls through to Exa the same lap, same as any other
    // failure.
    gemini: createGeminiClient(geminiApiKey),
    exa: createFallbackExaClient(exaClients),
    tavily: createTavilyClient(tavilyApiKey),
  }

  const pool = createDbPool(dbUrl)

  logger.info(`looping indefinitely, ${LOOP_DELAY_MS}ms pause between runs, up to ${limit} products/lap — Ctrl+C to stop`)
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const pending = await getPriceLookupCandidates(pool)
      const products = pending.slice(0, limit)
      logger.info(`${pending.length} pending price lookup, processing ${products.length} this lap`)
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Gemini/Exa/Tavily for retail/secondhand price-lookup on ${products.length} products this lap`)
      } else {
        await runPriceLookup(clients, pool, logger, products)
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
