import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { ExaClient, TavilyClient } from '../../domains/llm-clients'
import { createExaClient, createFallbackExaClient, createTavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import type { PriceLookupCandidate, PriceRange, PriceKind } from '../../domains/marketplace'
import {
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

// Exa (paid, structured, cites sources) -> Tavily (free, regex parsed) -
// first provider to return a real, non-wide-spread price wins. Exa-first for
// both retail and secondhand per a live head-to-head (2026-08-31, 15 real
// candidates, see discount-verification.ts's fetchFreshMarketContext
// comment for the full record): Exa cited sources and abstained honestly
// when it lacked real data, where Tavily confidently fabricated numbers
// with no citation trail. A provider that errors, comes back empty, or
// returns a suspiciously wide range falls through to the next one rather
// than failing the whole lookup.
const EXA_SOURCE: Record<PriceKind, PriceCheckSource> = { retail: 'exa_new_retail', secondhand: 'exa_secondhand' }
const TAVILY_SOURCE: Record<PriceKind, PriceCheckSource> = { retail: 'tavily_new_retail', secondhand: 'tavily_secondhand' }

async function lookupPrice(
  kind: PriceKind,
  clients: PriceLookupClients,
  product: PriceLookupCandidate,
  logger: Logger,
  label: string,
): Promise<PriceLookupResult | null> {
  try {
    const response = await clients.exa.searchStructured(buildExaQuery(kind, product), buildExaSystemPrompt(kind, product), EXA_PRICE_SCHEMA)
    const price = parseExaPriceResponse(response)
    if (price) {
      if (!isWideSpread(price)) return { price, source: EXA_SOURCE[kind], rawResponse: JSON.stringify(response) }
      logger.warn(`product ${product.id} (${label}): Exa ${kind} range too wide (${price.low}-${price.high}), falling back to Tavily`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Exa ${kind} lookup failed (${message}), falling back to Tavily`)
  }

  try {
    const result = await clients.tavily.search(buildTavilyQuery(kind, product))
    const text = tavilyText(result)
    const price = parseTavilyPriceAnswer(text)
    if (!price) return null
    if (isWideSpread(price)) {
      logger.warn(`product ${product.id} (${label}): Tavily ${kind} range too wide (${price.low}-${price.high}), dropped`)
      return null
    }
    return { price, source: TAVILY_SOURCE[kind], rawResponse: text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Tavily ${kind} lookup failed (${message})`)
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

    const retail = await lookupPrice('retail', clients, product, logger, label)
    const secondhand = await lookupPrice('secondhand', clients, product, logger, label)

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
        logger.info(`TEST_RUN: marketplace will call Exa/Tavily for retail/secondhand price-lookup on ${products.length} products this lap`)
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
