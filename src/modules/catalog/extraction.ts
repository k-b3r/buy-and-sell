import type { ExtractionCandidate } from './product-storage'
import {
  CANONICAL_BASE_MODEL,
  normalizeBaseModel,
  normalizeVariantTier,
  isProductCategory,
  isSubCategory,
} from './products'
import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'

// Same key shape as ExtractedListing.productKey, so an alias and its rule
// match on normalized text exactly as findProduct does when the merge script
// applies these rules after the fact.
function productKeyOf(baseModel: string, variant: string | null): string {
  return `${normalizeBaseModel(baseModel)}::${variant ? normalizeVariantTier(variant) : ''}`
}

// Built once at import: 318 rules, a plain Map, no I/O.
const ALIAS_RULE_BY_KEY = new Map(
  PRODUCT_VARIANT_ALIAS_RULES.map((rule) => [productKeyOf(rule.aliasBase, rule.aliasVariant), rule]),
)

// Fields of one item of the model's `results` array, unvalidated.
interface RawExtractionItem {
  id?: unknown
  base_model?: unknown
  variant?: unknown
  category?: unknown
  sub_category?: unknown
}

export interface ExtractedListing {
  candidate: ExtractionCandidate
  baseModel: string
  variant: string | null
  category: string | null
  subCategory: string | null
  // Listings with the same key belong to the same product row.
  productKey: string
}

type ExtractionItemOutcome =
  | { kind: 'malformed'; idHint: string }
  | { kind: 'unknown-candidate'; id: string }
  | { kind: 'extracted'; listing: ExtractedListing }

// Validates one response item against the batch it answers. Any value is
// accepted (the model can return null or non-object entries) and reported as
// malformed rather than thrown, same shape as parseEnrichmentItem.
export function parseExtractionItem(raw: unknown, batch: ExtractionCandidate[]): ExtractionItemOutcome {
  const item: RawExtractionItem = typeof raw === 'object' && raw !== null ? raw : {}
  if (typeof item.id !== 'string' || typeof item.base_model !== 'string') {
    return { kind: 'malformed', idHint: typeof item.id === 'string' ? item.id : '(missing/invalid id)' }
  }
  const candidate = batch.find((c) => c.id === item.id)
  if (!candidate) return { kind: 'unknown-candidate', id: item.id }

  const variant = typeof item.variant === 'string' && item.variant.trim() !== '' ? item.variant : null
  // Canonicalize known aliases (e.g. "PS5" -> "PlayStation 5") before the
  // lookup, so a listing extracted with an alias resolves to the same
  // product_id as one extracted with the canonical form - no duplicate
  // product row ever gets created for aliases already on this list. Only
  // catches known aliases; a brand-new one extraction turns up still
  // needs a human to spot it and add an entry (same gap as
  // pricing's ineligible-categories.ts curated list) - product-merge.ts
  // remains the manual retroactive fix for whatever slips through.
  const mappedBaseModel = CANONICAL_BASE_MODEL[item.base_model] ?? item.base_model
  // Base+variant aliases too (BUY-59): found live 2026-10-08, 24 of these
  // rules matched products extraction had created again after the 2026-09-02
  // merge, because only the manual merge script applied them.
  const aliasRule = ALIAS_RULE_BY_KEY.get(productKeyOf(mappedBaseModel, variant))
  const baseModel = aliasRule ? aliasRule.canonicalBase : mappedBaseModel
  const resolvedVariant = aliasRule ? aliasRule.canonicalVariant : variant
  return {
    kind: 'extracted',
    listing: {
      candidate,
      baseModel,
      variant: resolvedVariant,
      // Dashboard browsing/filtering aid only - a missing/invalid category
      // falls back to null rather than skipping the whole item, since
      // base_model assignment matters far more than category.
      category: isProductCategory(item.category) ? item.category : null,
      subCategory: isSubCategory(item.sub_category) ? item.sub_category : null,
      productKey: productKeyOf(baseModel, resolvedVariant),
    },
  }
}
