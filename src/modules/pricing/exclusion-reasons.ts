// Reasons for products.price_lookup_excluded: every write of the flag goes
// through store/exclusion.ts with a reason from this list. The signals behind
// those reasons stay separate on purpose (they're genuinely different
// sources); only the write and its vocabulary converge:
//   real_estate, too_generic, parts_accessory, service - text heuristic
//     (detectGenericBaseModel in generic-products.ts, applied live by
//     ensureProductPriced)
//     or the human-curated lists in ineligible-categories.ts
//   needs_component_pricing - human-curated (ineligible-categories.ts)
//   groq_generic - LLM judgment (applyEligibilityFromEnrichment below)
//   retail_not_found - no provider found a retail price (ensureProductPriced)
//   manual_review - a human excluded it from the needs-review page
// exa_no_result is retired (historical rows only).
export const PRICE_EXCLUSION_REASONS = [
  'real_estate',
  'too_generic',
  'parts_accessory',
  'service',
  'needs_component_pricing',
  'groq_generic',
  'retail_not_found',
  'manual_review',
] as const

export type PriceExclusionReason = (typeof PRICE_EXCLUSION_REASONS)[number]

// Reasons that record a failed price search, not a verdict on the product,
// including retired ones still on old rows. Including such a product is a
// retry: if the search fails again it is re-excluded, which is correct.
// Every other reason is a judgment, and including it records an override.
export const LOOKUP_OUTCOME_REASONS = [
  'retail_not_found',
  'exa_no_result',
  'exa_wide_spread',
  'exa_low_confidence',
  'claude_no_result',
] as const
