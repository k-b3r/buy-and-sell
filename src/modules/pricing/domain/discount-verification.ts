import { DEFAULT_DISCOUNT_POLICY } from './discount-policy'
import type { DiscountPolicyThresholds, DiscountVerificationCandidate } from '../types'

export interface ParsedVerificationResponse {
  stillDiscounted: boolean
  freshPriceLow: number
  freshPriceHigh: number
  conditionExplainsLowPrice: boolean
  meetsProfitBar: boolean
  reasoning: string
}

export function parseVerificationResponse(raw: unknown): ParsedVerificationResponse | null {
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
// stale pre-minPricePesos rows already sitting in the table), non-generic
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
export type PrecheckOutcome = { outcome: 'proceed' } | { outcome: 'rejected' | 'pending'; reasoning: string }

// The free, synchronous gates - no DB/network I/O, safe to run against every
// pending candidate every lap regardless of the paid-API budget (the worker
// loop uses this to process its whole backlog for these two outcomes as fast
// as candidates arrive, only rationing the expensive path below). Pulled out
// of verifyDiscountCandidate so the loop can budget paid calls without
// duplicating this logic.
export function precheckDiscountCandidate(
  candidate: DiscountVerificationCandidate,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): PrecheckOutcome {
  if (candidate.price_amount < thresholds.minPricePesos) {
    return {
      outcome: 'rejected',
      reasoning: `Asking price below the ₱${thresholds.minPricePesos} floor - not worth chasing regardless of discount math.`,
    }
  }
  if (candidate.is_specific_product === false) {
    return { outcome: 'rejected', reasoning: 'Product is not a specific, priceable item.' }
  }
  if (candidate.is_specific_product === null) {
    return { outcome: 'pending', reasoning: 'Product enrichment not yet available.' }
  }
  return { outcome: 'proceed' }
}
