export function normalizeBaseModel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Light-touch only — catches trivial noise (case, whitespace, contraction
// apostrophes like "Founder's" vs "Founders") without doing any real semantic
// merging (e.g. "FE" vs "Founders Edition" still land as separate products).
// Deliberate deduplication across those is a later, human/AI-assisted phase.
export function normalizeVariantTier(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/\s+/g, ' ')
}

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

// Fixed, bounded list for dashboard browsing/filtering only (not used to
// drive pipeline logic) - freeform categorization would recreate the exact
// base_model fragmentation problem this session spent real effort cleaning
// up (see CONTEXT.md's duplicate-product consolidation finding), just one
// level higher. "Other" is the required catch-all for anything that doesn't
// fit, so the model is never forced to guess a bad fit.
export const PRODUCT_CATEGORIES = [
  'Phones & Tablets',
  'Computers & Laptops',
  'PC Components',
  'Cameras & Drones',
  'Audio',
  'Gaming',
  'TVs & Monitors',
  'Appliances',
  'Vehicles',
  'Real Estate',
  'Fashion',
  'Fitness & Outdoor',
  'Furniture & Home',
  'Other',
] as const

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

Also assign a "category" for each listing - exactly one of: ${PRODUCT_CATEGORIES.join(', ')}.
Use "Other" if none genuinely fit rather than forcing a bad match.

Listings:
${lines}`
}

export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      base_model: { type: 'string' },
      variant: { type: 'string' },
      category: { type: 'string', enum: PRODUCT_CATEGORIES },
    },
    required: ['id', 'base_model', 'category'],
  },
} as const
