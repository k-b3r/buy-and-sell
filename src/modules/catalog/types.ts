// Types shared by this module's own files. Row types stay in store/.

import type { ListingPriceReview } from '../pricing'

export interface EnrichmentCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  sibling_variants: string[]
  category: string | null
}

export interface EnrichmentData {
  description: string
  valueDrivers: string
  hasTrainedPriceKnowledge: boolean
  trainedPriceLow: number | null
  trainedPriceHigh: number | null
  isSpecificProduct: boolean
  confidence: 'high' | 'low'
}

export interface ExtractionCandidate {
  id: string
  title: string
  description: string | null
  condition: string | null
  price_amount: number | null
}

export interface ProductEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
}

export interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  listed_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  // Shares its normalized title with another listing of this product
  // (pricing's computeRepostIds over the full set, before any dashboard
  // filtering or paging).
  is_repost: boolean
  // The model's own reasoning for why this exact listing cleared the
  // verification gate (discount-verification.ts's VerificationOutcome,
  // 'verified' case) - null for any listing that never got a verified
  // discount_notifications row, not just an unflagged one.
  verification_reasoning: string | null
}

// Generalizes mergeDuplicateProducts (base_model-only rename) to also move
// text between base_model and variant_tier - most of the duplicate-product
// cases found in the 2026-09-02 catalog scan are exactly that (e.g.
// "iPhone 14 Plus" [] should be "iPhone 14" [Plus]), which the simpler tool
// can't express since it only ever rewrites base_model and assumes
// variant_tier already matches between alias and canonical.
export interface ProductAliasRule {
  aliasBase: string
  aliasVariant: string | null
  canonicalBase: string
  canonicalVariant: string | null
}
