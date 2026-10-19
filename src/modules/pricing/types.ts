// Types and ports shared by this module's own files. Row types stay in store/.

import type { ExaClient, GeminiClient, OpenRouterClient, TavilyClient } from '../../platform/llm-clients'
import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'

// A price range a provider returned, in the currency it quoted.
export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

export interface PriceLookupClients {
  gemini: GeminiClient
  exa: ExaClient
  tavily: TavilyClient
}

export interface PriceLookupDeps {
  clients: PriceLookupClients
  db: DbClient
  logger: Logger
}

export interface ProductPricingResult {
  retail: PriceRange | null
  secondhand: PriceRange | null
  excluded: boolean
}

// The I/O port discount verification needs from the search and judgement
// clients; the workers bind concrete clients to it.
export interface VerificationClients {
  tavily: TavilyClient
  exa: ExaClient
  gemini: GeminiClient
  openrouter: OpenRouterClient
}

export interface DiscountVerificationCandidate {
  id: number
  listing_id: string
  title: string | null
  description: string | null
  condition: string | null
  price_amount: number
  base_model: string
  is_specific_product: boolean | null
}

export type VerificationOutcome =
  | { outcome: 'verified'; discountPercent: number; referencePrice: number; source: string; reasoning: string }
  | { outcome: 'rejected'; reasoning: string }
  | { outcome: 'pending'; reasoning: string }

// Strongest evidence first: DEALS_CONFIDENCE_TIERS (deals.ts) is this union's
// runtime list.
export type DealsConfidenceTier = 'sold_comps' | 'peer_listings' | 'llm_estimate'

export interface DealListing {
  listing_id: string
  title: string
  ask_price: number
  photo_url: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  reference_price: number | null
  tier: DealsConfidenceTier | null
  // Count of comparable listings behind the winning tier - sold listings for
  // sold_comps, active peer listings for peer_listings, null for
  // llm_estimate (nothing to count) or no tier at all.
  comp_count: number | null
  profit_pesos: number | null
  discount_percent: number | null
  days_listed: number | null
  is_saved: boolean
  is_low_confidence: boolean
}

export interface DealsDiscountPolicyFloors {
  minProfitPesos: number
  minPricePesos: number
}

export interface DealsFilters {
  search?: string
  categories?: string[]
  minProfitPesos?: number
  minConfidenceTier?: DealsConfidenceTier
  maxDaysListed?: number
  // Hours since our collector first saw the listing (first_seen_at), not the
  // seller's FB posting date that maxDaysListed uses.
  addedWithinHours?: number
  soldOnly?: boolean
  lowConfidenceOnly?: boolean
  offset?: number
  limit?: number
}

export interface DiscountBand {
  bandFloor: number
  count: number
}

export interface ListingPriceReview {
  is_negotiable: boolean
  price_low: number | null
  price_high: number | null
}

export interface DiscountPolicyThresholds {
  highDiscountThresholdPercent: number
  minProfitPesos: number
  minPricePesos: number
}

export interface NewDiscountNotification {
  listingId: string
  productId: number
  discountPercent: number
  referencePrice: number
}

// The exclusion vocabulary, mirrored at runtime by PRICE_EXCLUSION_REASONS
// (domain/exclusion-reasons.ts).
export type PriceExclusionReason =
  | 'real_estate'
  | 'too_generic'
  | 'parts_accessory'
  | 'service'
  | 'needs_component_pricing'
  | 'groq_generic'
  | 'retail_not_found'
  | 'manual_review'

export interface TriageCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  description: string | null
  reason: string
  listing_count: number
  median_ask: number | null
  sample_titles: string[]
}

export type TriageConfidence = 'high' | 'medium' | 'low'

export interface TriageRow {
  productId: number
  previousReason: string
  verdict: 'retry' | 'keep_excluded'
  isSpecificProduct: boolean
  confidence: TriageConfidence
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}

export interface PriceReviewCandidate {
  id: string
  title: string
  description: string | null
  price_amount: number
}

export interface PriceReviewData {
  isNegotiable: boolean
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}
