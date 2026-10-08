import { LOOKUP_OUTCOME_REASONS } from './shared.generated'

// Display copy for products.price_lookup_excluded_reason, including retired
// reasons still on old rows. Client-safe: no server imports.
const REASON_LABELS: Record<string, string> = {
  retail_not_found: 'No retail price found',
  exa_no_result: 'No price found (old Exa search)',
  exa_wide_spread: 'Prices too spread out (old Exa search)',
  exa_low_confidence: 'Low-confidence price (old Exa search)',
  claude_no_result: 'No price found (old Claude search)',
  groq_generic: 'AI judged it not a specific product',
  too_generic: 'Too generic to price',
  generic_category: 'Generic category (old rule)',
  real_estate: 'Real estate',
  parts_accessory: 'Part or accessory',
  service: 'Service, not a product',
  needs_component_pricing: 'Needs per-component pricing',
  manual_review: 'Excluded by hand',
  unknown: 'No reason recorded',
}

export function exclusionLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason
}

// A failed price search, so including the product retries the lookup;
// anything else is a verdict, and including it overrides that verdict.
export function isRetryReason(reason: string): boolean {
  return (LOOKUP_OUTCOME_REASONS as readonly string[]).includes(reason)
}

export function includeExplanation(reason: string): string {
  return isRetryReason(reason)
    ? 'Price lookup will try this product again. If no price turns up, it is excluded again.'
    : 'Price lookup will include this product, and the automatic rules will no longer exclude it.'
}
