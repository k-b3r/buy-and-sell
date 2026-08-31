import type { GeminiClient, OpenRouterClient, ExaClient, TavilyClient } from '../llm-clients'
import type { DiscountVerificationCandidate } from './storage/listings'
import { MIN_PROFIT_PESOS, MIN_PRICE_PESOS } from './storage/listings'

export type VerificationOutcome =
  | { outcome: 'verified'; discountPercent: number; referencePrice: number; source: string; reasoning: string }
  | { outcome: 'rejected'; reasoning: string }
  | { outcome: 'pending'; reasoning: string }

export interface VerificationClients {
  tavily: TavilyClient
  exa: ExaClient
  gemini: GeminiClient
  openrouter: OpenRouterClient
}

// "New" listings need a current retail search; anything else (the vast
// majority — "Used - Good", "Used - Fair", etc.) needs a secondhand/resale
// search instead. Facebook's condition labels are free text, not an enum,
// so this is a loose substring check rather than a fixed set. "used" is
// checked first and wins outright - "Used - like new" contains "new" but is
// never actually new-in-box, and used to get misread as New here, comparing
// a secondhand item against brand-new retail pricing (confirmed live via a
// Qwen3.5-9B/DeepSeek judgement eval, 2026-08-30: an 84%-battery iPhone XR
// and a "slightly used" Apple Pencil both got priced against retail instead
// of secondhand because of this).
function isNewCondition(condition: string | null): boolean {
  if (condition === null) return false
  const lower = condition.toLowerCase()
  if (lower.includes('used')) return false
  return lower.includes('new')
}

// base_model alone is often too generic to search accurately - "HP Laptop"/
// "Desktop" spans a huge price range by spec, and the extraction step that
// produces base_model deliberately strips those specs out. The listing's own
// title/description usually still carries the real distinguishing details
// (CPU/RAM/storage), so they're appended as a disambiguating hint - a search
// engine keys on the high-signal spec tokens fine even amid marketing noise.
// Confirmed live 2026-08-30: bare "HP Laptop"/"Desktop" queries pulled
// pricing for far stronger configs than the actual budget units being priced.
const SPEC_HINT_MAX_LENGTH = 200

export function buildPriceQuery(candidate: DiscountVerificationCandidate): string {
  const kind = isNewCondition(candidate.condition) ? 'current retail price' : 'current secondhand/resale price'
  const specHint = [candidate.title, candidate.description].filter((s): s is string => Boolean(s)).join(' ').slice(0, SPEC_HINT_MAX_LENGTH)
  const label = specHint ? `${candidate.base_model} (${specHint})` : candidate.base_model
  return `${kind} of ${label} in the Philippines`
}

const EXA_SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
} as const

// Tries Exa first, then Tavily, then Gemini grounding — first provider to
// return real (non-empty) text wins. A provider that errors or comes back
// empty falls through to the next one rather than failing the whole
// candidate; only exhausting all three means "no fresh data available right
// now." Exa-first (not Tavily-first) per a live head-to-head comparison
// (2026-08-31, 15 real candidates): Exa cited sources and abstained honestly
// when it lacked real secondhand data, where Tavily confidently fabricated
// numbers with no citation trail - caught concretely wrong Tavily answers
// (a "secondhand" price higher than Exa's own cited new-retail price on a
// monitor; a raw USD figure returned for a PHP-scoped query on a watch).
// Exa costs ~$0.007/call vs Tavily's free tier, but this worker's own
// DEFAULT_LAP_LIMIT (3 candidates/lap) keeps that cost trivial - accuracy
// matters more here since this gates a real buy decision.
async function fetchFreshMarketContext(
  candidate: DiscountVerificationCandidate,
  clients: Pick<VerificationClients, 'tavily' | 'exa' | 'gemini'>,
): Promise<{ text: string; source: string } | null> {
  const query = buildPriceQuery(candidate)

  try {
    const exaResult = (await clients.exa.searchStructured(query, 'Summarize the current market price context.', EXA_SUMMARY_SCHEMA)) as {
      output?: { content?: { summary?: string } }
    }
    const summary = exaResult.output?.content?.summary
    if (summary && summary.trim().length > 0) return { text: summary, source: 'exa' }
  } catch {
    // fall through to Tavily
  }

  try {
    const tavilyResult = await clients.tavily.search(query)
    const text = tavilyResult.answer ?? tavilyResult.results.map((r) => r.content).join('\n')
    if (text.trim().length > 0) return { text, source: 'tavily' }
  } catch {
    // fall through to Gemini
  }

  try {
    const text = await clients.gemini.generateGroundedText(`Search for the ${query}. Summarize what you find.`)
    if (text.trim().length > 0) return { text, source: 'gemini_grounding' }
  } catch {
    // all three exhausted
  }

  return null
}

export function buildVerificationPrompt(candidate: DiscountVerificationCandidate, marketContext: string): string {
  return `A listing was flagged as a possible deal by a statistical price check. Judge whether it's a genuine, meaningful opportunity, using the fresh market data below — not the original statistical flag.

Listing:
title: "${candidate.title ?? ''}"
description: "${candidate.description ?? ''}"
condition: "${candidate.condition ?? 'unknown'}"
asking price: ₱${candidate.price_amount}

Fresh market data (from a live web search):
${marketContext}

Determine:
- still_discounted: true only if the asking price is genuinely at least 30% below the fresh market price above (secondhand market price for a used item, current retail price for a New one)
- fresh_price_low / fresh_price_high: your best read of the current market price range from the market data above
- condition_explains_low_price: true if the listing's own stated condition/defects (e.g. cracked screen, missing parts, heavy wear) plausibly explain why it's priced this low on their own — meaning this ISN'T actually an underpriced bargain, just a fairly-priced damaged item. False if the condition is normal/minor wear that doesn't explain a price this low.
- meets_profit_bar: true only if (fresh_price_low - asking price) is at least ₱${MIN_PROFIT_PESOS}
- reasoning: one or two sentences explaining your judgement

Respond with the structured fields only.`
}

export const VERIFICATION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    still_discounted: { type: 'boolean' },
    fresh_price_low: { type: 'number' },
    fresh_price_high: { type: 'number' },
    condition_explains_low_price: { type: 'boolean' },
    meets_profit_bar: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['still_discounted', 'fresh_price_low', 'fresh_price_high', 'condition_explains_low_price', 'meets_profit_bar', 'reasoning'],
  additionalProperties: false,
} as const

interface ParsedVerificationResponse {
  stillDiscounted: boolean
  freshPriceLow: number
  freshPriceHigh: number
  conditionExplainsLowPrice: boolean
  meetsProfitBar: boolean
  reasoning: string
}

function parseVerificationResponse(raw: unknown): ParsedVerificationResponse | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.still_discounted !== 'boolean' ||
    typeof r.fresh_price_low !== 'number' ||
    typeof r.fresh_price_high !== 'number' ||
    typeof r.condition_explains_low_price !== 'boolean' ||
    typeof r.meets_profit_bar !== 'boolean' ||
    typeof r.reasoning !== 'string'
  ) {
    return null
  }
  return {
    stillDiscounted: r.still_discounted,
    freshPriceLow: r.fresh_price_low,
    freshPriceHigh: r.fresh_price_high,
    conditionExplainsLowPrice: r.condition_explains_low_price,
    meetsProfitBar: r.meets_profit_bar,
    reasoning: r.reasoning,
  }
}

// The 5 gates, in order: price floor (free, deterministic - also catches
// stale pre-MIN_PRICE_PESOS rows already sitting in the table), non-generic
// (reused, free), fresh price context (Exa -> Tavily -> Gemini), then one
// OpenRouter (DeepSeek) call judging the remaining 3 (still discounted /
// condition doesn't explain it away / profit bar) — fail-closed throughout:
// any ambiguous or erroring state is 'pending' (retried later), never
// treated as a silent pass. DeepSeek
// replaced Groq here following two evals: a 4/8-sample Qwen3.5-9B run found
// a real gap (structured fields sometimes flatly contradicted its own
// reasoning text), then a 15-sample DeepSeek run had zero such flat
// contradictions - a couple of softer/hedgy calls, but nothing like Qwen's
// reversals - and DeepSeek independently ranks well on judge-quality
// benchmarks despite being one of the cheapest models tested. Note: most of
// that eval's wrong final verdicts traced to a bad market-context reference
// price, not bad reasoning over a good one - market-context accuracy (the
// Exa reorder above) turned out to be the bigger lever than judge choice.
export async function verifyDiscountCandidate(
  candidate: DiscountVerificationCandidate,
  clients: VerificationClients,
): Promise<VerificationOutcome> {
  if (candidate.price_amount < MIN_PRICE_PESOS) {
    return { outcome: 'rejected', reasoning: `Asking price below the ₱${MIN_PRICE_PESOS} floor - not worth chasing regardless of discount math.` }
  }
  if (candidate.is_specific_product === false) {
    return { outcome: 'rejected', reasoning: 'Product is not a specific, priceable item.' }
  }
  if (candidate.is_specific_product === null) {
    return { outcome: 'pending', reasoning: 'Product enrichment not yet available.' }
  }

  const context = await fetchFreshMarketContext(candidate, clients)
  if (context === null) {
    return { outcome: 'pending', reasoning: 'No fresh market data available from any provider.' }
  }

  let raw: unknown
  try {
    raw = await clients.openrouter.generateJson(buildVerificationPrompt(candidate, context.text), VERIFICATION_RESPONSE_SCHEMA)
  } catch {
    return { outcome: 'pending', reasoning: 'Verification judgement call failed.' }
  }

  const parsed = parseVerificationResponse(raw)
  if (parsed === null) {
    return { outcome: 'pending', reasoning: 'Verification judgement returned a malformed response.' }
  }

  if (!parsed.stillDiscounted || parsed.conditionExplainsLowPrice || !parsed.meetsProfitBar) {
    return { outcome: 'rejected', reasoning: parsed.reasoning }
  }

  const referencePrice = parsed.freshPriceLow
  const discountPercent = Math.round(((referencePrice - candidate.price_amount) / referencePrice) * 100)
  return { outcome: 'verified', discountPercent, referencePrice, source: context.source, reasoning: parsed.reasoning }
}
