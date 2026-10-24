import type { TriageCandidate, TriageConfidence, TriageRow } from '../types'

// One-off LLM triage of products excluded from price lookup (BUY-60): per
// product a verdict (retry the lookup or keep it excluded) plus a rough
// new-retail estimate, logged to product_pricing_triage. Nothing changes
// pricing until a human reviews the log and runs applyTriageVerdicts.

type Verdict = 'retry' | 'keep_excluded'
const VERDICTS = new Set(['retry', 'keep_excluded'])
const CONFIDENCES = new Set(['high', 'medium', 'low'])

type ParsedItem =
  { kind: 'ok'; row: TriageRow } | { kind: 'malformed'; idHint: string } | { kind: 'unknown-candidate'; id: number }

// An estimate only counts as a usable range: both ends present, positive, low <= high.
function priceRange(low: unknown, high: unknown): { priceLow: number | null; priceHigh: number | null } {
  if (typeof low !== 'number' || typeof high !== 'number' || low <= 0 || low > high) {
    return { priceLow: null, priceHigh: null }
  }
  return { priceLow: low, priceHigh: high }
}

export function parseTriageItem(raw: unknown, batch: TriageCandidate[]): ParsedItem {
  const item = (raw ?? {}) as Record<string, unknown>
  const id = item.product_id
  if (
    typeof id !== 'number' ||
    typeof item.verdict !== 'string' ||
    !VERDICTS.has(item.verdict) ||
    typeof item.is_specific_product !== 'boolean' ||
    typeof item.confidence !== 'string' ||
    !CONFIDENCES.has(item.confidence) ||
    typeof item.reasoning !== 'string'
  ) {
    return { kind: 'malformed', idHint: String(id) }
  }
  const candidate = batch.find((c) => c.id === id)
  if (!candidate) return { kind: 'unknown-candidate', id }
  return {
    kind: 'ok',
    row: {
      productId: id,
      previousReason: candidate.reason,
      verdict: item.verdict as Verdict,
      isSpecificProduct: item.is_specific_product,
      confidence: item.confidence as TriageConfidence,
      ...priceRange(item.price_low_php, item.price_high_php),
      reasoning: item.reasoning,
    },
  }
}
