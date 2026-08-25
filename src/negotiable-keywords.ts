interface KeywordPattern {
  label: string
  pattern: RegExp
}

// PH FB Marketplace shorthand ("nego") sits alongside the standard English
// phrasing - both are common enough here to check for by default. Each
// pattern is checked independently against the whole title+description text;
// order determines which label wins when a listing matches more than one
// (doesn't matter functionally, first match is returned).
const NEGOTIABLE_PATTERNS: KeywordPattern[] = [
  { label: 'negotiable', pattern: /\bnegotiable\b/i },
  { label: 'nego', pattern: /\bnego\b/i },
  { label: 'negotiate', pattern: /\bnegotiat(?:e|ing|ion)\b/i },
  { label: 'obo', pattern: /\bo\.?b\.?o\.?\b/i },
  { label: 'best offer', pattern: /\bbest offer\b/i },
  { label: 'open to offers', pattern: /\bopen to offers?\b/i },
  { label: 'make an offer', pattern: /\bmake (?:an )?offer\b/i },
]

// Returns the label of the first negotiability signal found in title +
// description, or null if neither mentions one - even when price_amount is a
// perfectly normal, non-placeholder number. This is independent of (and
// deliberately does not replace) the LLM-based price-review negotiability
// read (src/price-review.ts), which only ever runs on price-outlier
// candidates - see isListingPriceNegotiable's callers in the dashboard for
// how the two signals combine.
export function matchesNegotiableKeyword(title: string | null, description: string | null = null): string | null {
  const text = `${title ?? ''} ${description ?? ''}`
  if (!text.trim()) return null
  for (const { label, pattern } of NEGOTIABLE_PATTERNS) {
    if (pattern.test(text)) return label
  }
  return null
}
