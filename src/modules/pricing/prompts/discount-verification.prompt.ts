// What the discount-verification model is told, plus the plain-text search
// query the market context is fetched with, and the schema the answer must
// satisfy. Prose first on purpose: edit here to retune the verdicts. Parsing
// and the precheck stay in domain/discount-verification.ts.
import { DEFAULT_DISCOUNT_POLICY } from '../domain/discount-policy'
import { isNewCondition } from '../domain/price-rules'
import type { DiscountPolicyThresholds, DiscountVerificationCandidate } from '../types'

// base_model alone is often too generic to search accurately - "HP Laptop"/
// "Desktop" spans a huge price range by spec, and the extraction step that
// produces base_model deliberately strips those specs out. The listing's own
// title/description usually still carries the real distinguishing details
// (CPU/RAM/storage), so they're appended as a disambiguating hint - a search
// engine keys on the high-signal spec tokens fine even amid marketing noise.
// Confirmed live 2026-08-30: bare "HP Laptop"/"Desktop" queries pulled
// pricing for far stronger configs than the actual budget units being priced.
export function buildVerificationPrompt(
  candidate: DiscountVerificationCandidate,
  marketContext: string,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): string {
  return `A listing was flagged as a possible deal by a statistical price check. Judge whether it's a genuine, meaningful opportunity, using the fresh market data below — not the original statistical flag.

Listing:
title: "${candidate.title ?? ''}"
description: "${candidate.description ?? ''}"
condition: "${candidate.condition ?? 'unknown'}"
asking price: ₱${candidate.price_amount}

Fresh market data (from a live web search):
${marketContext}

Determine:
- still_discounted: true only if the asking price is genuinely at least ${thresholds.highDiscountThresholdPercent}% below the fresh market price above (secondhand market price for a used item, current retail price for a New one)
- fresh_price_low / fresh_price_high: your best read of the current market price range from the market data above
- condition_explains_low_price: true if the listing's own stated condition/defects (e.g. cracked screen, missing parts, heavy wear) plausibly explain why it's priced this low on their own — meaning this ISN'T actually an underpriced bargain, just a fairly-priced damaged item. False if the condition is normal/minor wear that doesn't explain a price this low.
- meets_profit_bar: true only if (fresh_price_low - asking price) is at least ₱${thresholds.minProfitPesos}
- reasoning: one or two sentences explaining your judgement

Respond with the structured fields only.`
}

const SPEC_HINT_MAX_LENGTH = 200

export function buildPriceQuery(candidate: DiscountVerificationCandidate): string {
  const kind = isNewCondition(candidate.condition) ? 'current retail price' : 'current secondhand/resale price'
  const specHint = [candidate.title, candidate.description]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .slice(0, SPEC_HINT_MAX_LENGTH)
  const label = specHint ? `${candidate.base_model} (${specHint})` : candidate.base_model
  return `${kind} of ${label} in the Philippines`
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
  required: [
    'still_discounted',
    'fresh_price_low',
    'fresh_price_high',
    'condition_explains_low_price',
    'meets_profit_bar',
    'reasoning',
  ],
  additionalProperties: false,
} as const
