import type { ExtractionCandidate } from './types'
import {
  CANONICAL_BASE_MODEL,
  normalizeBaseModel,
  normalizeVariantTier,
  isProductCategory,
  isSubCategory,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
} from './products'
import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'

export interface ExtractionInput {
  id: string
  title: string
  description: string
}

const DESCRIPTION_TRUNCATE_LENGTH = 150

function formatListingLine(l: ExtractionInput): string {
  const desc = l.description.slice(0, DESCRIPTION_TRUNCATE_LENGTH)
  return `[id: ${l.id}] title: "${l.title}" desc: "${desc}"`
}

export function buildExtractionPrompt(listings: ExtractionInput[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  return `Extract the base product model from each Facebook Marketplace listing below.
Return ONLY the core product line/model - strip seller phrases ("RUSH", "FOR SALE"),
condition, price, storage/color, and edition/variant details (write "RTX 3060" not
"RTX 3060 OC Asus"; write "iPhone 13" not "iPhone 13 128GB Blue"). If genuinely
unidentifiable even from the description, use a general category instead ("Laptop",
"Bicycle") rather than guessing wrong.

Also extract a "variant" for each listing ONLY when the title/description clearly
signals a specific edition/trim that plausibly affects its value (e.g. "Founders
Edition", "Custom AIB/OC", "Pro", "Max"). Leave variant as an empty string ""
when no such signal is present - do NOT use storage capacity or color as a variant.

If the base model name itself ends in a known trim/tier word, move that word into
variant instead of leaving it in base_model - the same product must always produce
the same base_model regardless of which trim was in the listing title. For example:
- "iPhone 14 Plus" -> base_model: "iPhone 14", variant: "Plus"
- "iPad 9th Gen" / "iPad 9th Generation" -> base_model: "iPad", variant: "9th Gen"
- "MacBook Air M2" -> base_model: "MacBook Air", variant: "M2"
- "Galaxy S23 Ultra" -> base_model: "Samsung Galaxy S23", variant: "Ultra"
Never repeat the same trim word in both base_model and variant.

Only record a network band ("5G"/"4G") as variant when the same base model is
genuinely sold in more than one band - if every listing you've seen for that model
is 5G, leave variant empty rather than tagging every one of them "5G".

Also assign a "category" for each listing - exactly one of: ${PRODUCT_CATEGORIES.join(', ')}.
Use "Other" if none genuinely fit rather than forcing a bad match.

Also assign a finer "sub_category" for each listing - exactly one of: ${SUB_CATEGORIES.join(', ')}.
Pick whichever fits best regardless of which "category" you chose above (e.g. a listing you put
under "Computers & Laptops" might still be "Graphics Cards" or "Consoles" if that's a better fit -
the two fields are judged independently). Use "Other" if none genuinely fit.

Listings:
${lines}`
}

// Root type must be 'object', not 'array' - confirmed live 2026-09-03 via a
// direct call: Groq hard-rejects any response_format schema whose top level
// isn't 'object' ("schema must have type 'object' and not have
// 'oneOf'/'anyOf'/'enum'/'not' at the top level"), on every model, not just
// a specific one - this had silently been failing every single Groq call
// and falling through to Gemini instead. Wrapped in the same {results: [...]}
// envelope every other schema in this file already uses; variant is nullable
// rather than omitted from `required`, since strict mode requires every
// property be listed there.
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          base_model: { type: 'string' },
          variant: { type: ['string', 'null'] },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
          sub_category: { type: 'string', enum: SUB_CATEGORIES },
        },
        required: ['id', 'base_model', 'variant', 'category', 'sub_category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

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
  // pricing's ineligible-categories.ts curated list) - merge.ts
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
