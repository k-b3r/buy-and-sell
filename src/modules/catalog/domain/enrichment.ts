import { isProductCategory } from './products'
import type { EnrichmentCandidate, EnrichmentData } from '../types'

// Fields of one item of the model's `results` array, unvalidated.
interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
  category?: unknown
  is_specific_product?: unknown
  confidence?: unknown
}

// What happens to the product's category once its enrichment is saved:
// 'keep' when it already has one, 'invalid' when it has none and the
// response's category isn't a valid one.
type CategoryDecision = { kind: 'keep' } | { kind: 'assign'; category: string } | { kind: 'invalid' }

type EnrichmentItemOutcome =
  | { kind: 'malformed'; idHint: string }
  | { kind: 'unknown-candidate'; id: string }
  | { kind: 'enriched'; candidate: EnrichmentCandidate; data: EnrichmentData; category: CategoryDecision }

// Validates one response item against the batch it answers. Category is
// best-effort, unlike the enrichment fields: a malformed category doesn't
// invalidate the enrichment itself. It only ever fills a gap: a candidate
// that already has a category (assigned at creation by product extraction)
// keeps it as-is. Any value is accepted (the model can return null or
// non-object entries) and reported as malformed rather than thrown.
export function parseEnrichmentItem(raw: unknown, batch: EnrichmentCandidate[]): EnrichmentItemOutcome {
  const item: RawEnrichmentItem = typeof raw === 'object' && raw !== null ? raw : {}
  if (
    typeof item.id !== 'string' ||
    typeof item.description !== 'string' ||
    typeof item.value_drivers !== 'string' ||
    typeof item.has_trained_price_knowledge !== 'boolean' ||
    typeof item.is_specific_product !== 'boolean' ||
    (item.confidence !== 'high' && item.confidence !== 'low')
  ) {
    return { kind: 'malformed', idHint: typeof item.id === 'string' ? item.id : '(missing/invalid id)' }
  }
  const id = item.id
  const candidate = batch.find((c) => String(c.id) === id)
  if (!candidate) return { kind: 'unknown-candidate', id }

  const data: EnrichmentData = {
    description: item.description,
    valueDrivers: item.value_drivers,
    hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
    trainedPriceLow: typeof item.trained_price_low === 'number' ? item.trained_price_low : null,
    trainedPriceHigh: typeof item.trained_price_high === 'number' ? item.trained_price_high : null,
    isSpecificProduct: item.is_specific_product,
    confidence: item.confidence,
  }
  return { kind: 'enriched', candidate, data, category: decideCategory(candidate, item.category) }
}

function decideCategory(candidate: EnrichmentCandidate, category: unknown): CategoryDecision {
  if (candidate.category !== null) return { kind: 'keep' }
  if (isProductCategory(category)) return { kind: 'assign', category }
  return { kind: 'invalid' }
}
