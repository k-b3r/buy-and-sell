import type { ExtractionCandidate } from './product-storage'
import {
  CANONICAL_BASE_MODEL,
  normalizeBaseModel,
  normalizeVariantTier,
  PRODUCT_CATEGORIES,
  SUB_CATEGORIES,
} from './products'

// One item of the model's `results` array, unvalidated.
export interface RawExtractionItem {
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

function oneOf(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null
}

// Validates one response item against the batch it answers. Returns null for
// an item without a string id/base_model or whose id matches no candidate.
export function parseExtractionItem(item: RawExtractionItem, batch: ExtractionCandidate[]): ExtractedListing | null {
  if (typeof item.id !== 'string' || typeof item.base_model !== 'string') return null
  const candidate = batch.find((c) => c.id === item.id)
  if (!candidate) return null

  const variant = typeof item.variant === 'string' && item.variant.trim() !== '' ? item.variant : null
  // Canonicalize known aliases (e.g. "PS5" -> "PlayStation 5") before the
  // lookup, so a listing extracted with an alias resolves to the same
  // product_id as one extracted with the canonical form - no duplicate
  // product row ever gets created for aliases already on this list. Only
  // catches known aliases; a brand-new one extraction turns up still
  // needs a human to spot it and add an entry (same gap as
  // flag-price-ineligible's curated list) - merge-duplicate-products.ts
  // remains the manual retroactive fix for whatever slips through.
  const baseModel = CANONICAL_BASE_MODEL[item.base_model] ?? item.base_model
  return {
    candidate,
    baseModel,
    variant,
    // Dashboard browsing/filtering aid only - a missing/invalid category
    // falls back to null rather than skipping the whole item, since
    // base_model assignment matters far more than category.
    category: oneOf(item.category, PRODUCT_CATEGORIES),
    subCategory: oneOf(item.sub_category, SUB_CATEGORIES),
    productKey: `${normalizeBaseModel(baseModel)}::${variant ? normalizeVariantTier(variant) : ''}`,
  }
}
