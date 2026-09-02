import type { Logger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../llm-clients'
import type { DbClient } from '../../platform/storage'
import type { PriceCheckSource } from './storage/pricing'
import { insertPriceCheck, flagProductPriceLookupExcluded } from './storage/pricing'
import { detectGenericBaseModel } from './generic-products'

export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

const WIDE_SPREAD_RATIO = 4

// A spread this wide usually means the search grounded to a whole product
// tier or market segment, not one specific product.
export function isWideSpread(price: PriceRange, maxRatio = WIDE_SPREAD_RATIO): boolean {
  return price.high > price.low * maxRatio
}

function productLabel(baseModel: string, variantTier: string | null): string {
  return variantTier ? `${baseModel} (${variantTier})` : baseModel
}

function disambiguationContext(candidate: PriceLookupCandidate): string {
  let context = ''
  if (candidate.description) context += ` Product context: ${candidate.description}.`
  if (candidate.sibling_variants.length > 0) {
    context += ` Other tracked variants of this same base model (price the requested one, not these): ${candidate.sibling_variants.join(', ')}.`
  }
  return context
}

export type PriceKind = 'retail' | 'secondhand'

// ---- Gemini: primary source for both retail and secondhand ----
// A live 5-product manual comparison (2026-08-31) found Gemini beat Exa on
// secondhand 2/3 but not retail, so only secondhand went Gemini-first. That
// small sample didn't hold up: live production data the same day showed
// Gemini actually winning only 17 of 992 secondhand lookups (1.7%) - the
// rest fell through to Exa/Tavily regardless. But FREE_GEMINI_API_KEY is a
// genuinely free (unbilled) key with a 500 RPD cap this workload is nowhere
// near hitting, so a Gemini attempt costs nothing even when it fails - it
// can only ever save an Exa/Tavily call, never add cost. Promoted to
// primary for retail too on that basis, per direct instruction 2026-09-02.
// Google Search grounding can't combine with responseSchema (confirmed
// live, see GeminiClient's own comment) - so this asks for a fenced json
// block in free text rather than relying on structured output.
export function buildGeminiPrompt(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  const ask =
    kind === 'retail'
      ? `the current brand-new retail price range in PHP for: ${label}, from official brand sites or known Philippine electronics/appliance retailers`
      : `the current secondhand/used market price range in PHP for: ${label}, based on real current listings (e.g. Facebook Marketplace, Carousell, Shopee) in the Philippines`
  return `Search for ${ask}.${disambiguationContext(candidate)}

Respond with a fenced json code block in this exact shape:
\`\`\`json
{"found": true, "price_low": <number>, "price_high": <number>}
\`\`\`
If you cannot find enough reliable information to determine a real price range, respond with {"found": false} instead of guessing.`
}

const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/

export function parseGeminiPriceResponse(text: string): PriceRange | null {
  const match = text.match(JSON_BLOCK_PATTERN)
  if (!match) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.found !== true) return null
  if (typeof r.price_low !== 'number' || typeof r.price_high !== 'number') return null
  return { low: r.price_low, high: r.price_high, currency: 'PHP' }
}

// ---- Exa: fallback 1 for both retail and secondhand (after Gemini) ----
// Per a live head-to-head against Tavily (2026-08-31, 15 real candidates,
// see discount-verification.ts's fetchFreshMarketContext comment for the
// full record) - Exa cited sources and abstained honestly when it lacked
// real data, where Tavily confidently fabricated numbers with no citation
// trail. Both chains: Gemini first (see above), Exa fallback 1, Tavily
// fallback 2.
export function buildExaQuery(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

export function buildExaSystemPrompt(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const base =
    kind === 'retail'
      ? 'Find the current brand-new retail price in Philippine Peso (PHP) from official brand sites and known PH electronics retailers - not a temporary promo or flash-sale price.'
      : 'Find the current secondhand (used) market price range in Philippine Peso (PHP) from real current listings (e.g. Facebook Marketplace, Carousell, Shopee).'
  return `${base}${disambiguationContext(candidate)} If you cannot find a reliable price, set found to false rather than guessing.`
}

export const EXA_PRICE_SCHEMA = {
  type: 'object',
  required: ['found'],
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true if a reliable current PHP price was found' },
    price_low: { type: 'number', description: 'lowest observed price in PHP' },
    price_high: { type: 'number', description: 'highest observed price in PHP' },
  },
} as const

// Exa's /search with outputSchema returns the structured result at
// response.output.content - same shape discount-verification.ts's
// EXA_SUMMARY_SCHEMA call already relies on.
export function parseExaPriceResponse(response: unknown): PriceRange | null {
  if (typeof response !== 'object' || response === null) return null
  const content = (response as { output?: { content?: unknown } }).output?.content
  if (typeof content !== 'object' || content === null) return null
  const r = content as Record<string, unknown>
  if (r.found !== true) return null
  if (typeof r.price_low !== 'number' || typeof r.price_high !== 'number') return null
  return { low: r.price_low, high: r.price_high, currency: 'PHP' }
}

// ---- Tavily: last-resort fallback for both (last stage of either chain) ----
export function buildTavilyQuery(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

// Tavily's include_answer has no structured output - per the
// pipeline-consolidation plan's decided approach, this extracts PHP amounts
// via regex rather than spending a second LLM call just to structure free
// text. Matches ₱/PHP-prefixed comma-grouped numbers (3+ digits) - a bare
// 1-2 digit number is far more likely a spec/year than a price, so it's
// excluded rather than risked.
const PRICE_AMOUNT_PATTERN = /(?:₱|PHP\s?)\s?([\d,]{3,})(?:\.\d+)?/gi

export function parseTavilyPriceAnswer(text: string | null): PriceRange | null {
  if (!text) return null
  const amounts: number[] = []
  for (const match of text.matchAll(PRICE_AMOUNT_PATTERN)) {
    const n = Number(match[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n >= 100 && n <= 10_000_000) amounts.push(n)
  }
  if (amounts.length === 0) return null
  return { low: Math.min(...amounts), high: Math.max(...amounts), currency: 'PHP' }
}

// ---- Orchestration: shared by price-lookup.ts's own backfill loop AND
// extract-products.ts's inline per-listing call, so both go through
// identical provider chains and exclusion rules. ----

export interface PriceLookupClients {
  gemini: GeminiClient
  exa: ExaClient
  tavily: TavilyClient
}

export interface PriceLookupResult {
  price: PriceRange
  source: PriceCheckSource
  rawResponse: string
}

function tavilyText(result: { answer: string | null; results: { content: string }[] }): string {
  return result.answer ?? result.results.map((r) => r.content).join('\n')
}

// Retail: Gemini (free, grounded) -> Exa (structured, cites sources) ->
// Tavily (free, regex parsed). Promoted to Gemini-first 2026-09-02 (see
// buildGeminiPrompt's comment) - same chain shape as lookupSecondhand below.
export async function lookupRetail(
  clients: PriceLookupClients,
  product: PriceLookupCandidate,
  logger: Logger,
  label: string,
): Promise<PriceLookupResult | null> {
  try {
    const text = await clients.gemini.generateGroundedText(buildGeminiPrompt('retail', product))
    const price = parseGeminiPriceResponse(text)
    if (price) {
      if (!isWideSpread(price)) return { price, source: 'gemini_new_retail', rawResponse: text }
      logger.warn(`product ${product.id} (${label}): Gemini retail range too wide (${price.low}-${price.high}), falling back to Exa`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`product ${product.id} (${label}): Gemini retail lookup failed (${message}), falling back to Exa`)
  }

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
// Tavily (free, regex parsed). Same Gemini-first shape lookupRetail now uses
// too - see buildGeminiPrompt's comment for why both chains lead with it.
export async function lookupSecondhand(
  clients: PriceLookupClients,
  product: PriceLookupCandidate,
  logger: Logger,
  label: string,
): Promise<PriceLookupResult | null> {
  try {
    const text = await clients.gemini.generateGroundedText(buildGeminiPrompt('secondhand', product))
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

export interface ProductPricingResult {
  retail: PriceRange | null
  secondhand: PriceRange | null
  excluded: boolean
}

// Ensures a product has retail/secondhand pricing, unconditionally attempting
// both (callers are responsible for skipping this call entirely when a
// product already has pricing or is already excluded - see
// getProductPricingStatus in storage/pricing.ts). Shared by price-lookup.ts's
// own backfill loop and extract-products.ts's inline per-listing trigger, so
// both go through identical provider chains and exclusion rules.
export async function ensureProductPriced(
  clients: PriceLookupClients,
  db: DbClient,
  product: PriceLookupCandidate,
  logger: Logger,
): Promise<ProductPricingResult> {
  const label = productLabel(product.base_model, product.variant_tier)

  // Cheap text-only check before spending any paid/quota call - same signal
  // getPriceLookupCandidates can't apply itself (it only knows
  // price_lookup_excluded is already false, not whether it plausibly
  // should be true).
  const generic = detectGenericBaseModel(product.base_model)
  if (generic) {
    await flagProductPriceLookupExcluded(db, product.id, generic.reason)
    logger.warn(`product ${product.id} (${label}): detected generic (${generic.reason}: "${generic.matched}"), flagged and skipping`)
    return { retail: null, secondhand: null, excluded: true }
  }

  const retail = await lookupRetail(clients, product, logger, label)
  if (!retail) {
    // Retail search failing across BOTH providers (Exa and Tavily) is a much
    // stronger signal than either alone - a real, specific, priceable
    // product almost always has *some* findable retail reference. Treated
    // as a generic/unpriceable-item signal, same permanent exclusion as the
    // text-pattern check above, per direct instruction (2026-08-31) - not
    // worth trying secondhand either.
    await flagProductPriceLookupExcluded(db, product.id, 'retail_not_found')
    logger.warn(`product ${product.id} (${label}): retail price not found via any provider, excluding from pricing entirely`)
    return { retail: null, secondhand: null, excluded: true }
  }
  await insertPriceCheck(db, product.id, retail.price, retail.rawResponse, retail.source, 'New')
  logger.info(`product ${product.id} (${label}): retail ${retail.price.low}-${retail.price.high} ${retail.price.currency} (${retail.source})`)

  const secondhand = await lookupSecondhand(clients, product, logger, label)
  if (secondhand) {
    await insertPriceCheck(db, product.id, secondhand.price, secondhand.rawResponse, secondhand.source, 'Used')
    logger.info(
      `product ${product.id} (${label}): secondhand ${secondhand.price.low}-${secondhand.price.high} ${secondhand.price.currency} (${secondhand.source})`,
    )
  } else {
    // Not excluded - unlike retail, a missing secondhand price is normal
    // (used-market data is just harder to find) and may become available
    // later some other way (a human entry, a future re-check). Per direct
    // instruction (2026-08-31): retail failing means "probably not a real
    // product," secondhand failing just means "no data yet."
    logger.warn(`product ${product.id} (${label}): secondhand price not found via any provider, may become available later`)
  }

  return { retail: retail.price, secondhand: secondhand?.price ?? null, excluded: false }
}
