export function normalizeBaseModel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Manually identified (2026-08-23) from a real scan of distinct base_model
// text — same real product, split into separate rows purely by inconsistent
// extraction text (abbreviation, spacing, "Galaxy" present or not). Every key
// here is an exact base_model string to retire in favor of its value.
export const CANONICAL_BASE_MODEL: Record<string, string> = {
  Airfryer: 'Air Fryer',
  Ebike: 'E-Bike',
  'GTX 1660Ti': 'GTX 1660 Ti',
  'Huawei MateBook D15': 'Huawei MateBook D 15',
  'Infinix GT30': 'Infinix GT 30',
  'JBL Party Box 320': 'JBL PartyBox 320',
  'Nvision Monitor': 'N-Vision Monitor',
  'RTX 3070ti': 'RTX 3070 Ti',
  'Samsung A07': 'Samsung Galaxy A07',
  'Samsung A16': 'Samsung Galaxy A16',
  'Samsung A36': 'Samsung Galaxy A36',
  'Samsung A54': 'Samsung Galaxy A54',
  'Samsung A55': 'Samsung Galaxy A55',
  'Samsung A57': 'Samsung Galaxy A57',
  'Samsung S21': 'Samsung Galaxy S21',
  'Samsung S22': 'Samsung Galaxy S22',
  'Samsung S23': 'Samsung Galaxy S23',
  'Samsung S24': 'Samsung Galaxy S24',
  'Samsung S25': 'Samsung Galaxy S25',
  'Samsung Galaxy S25 Series': 'Samsung Galaxy S25',
  'Samsung S26': 'Samsung Galaxy S26',
  'Samsung Galaxy Watch5': 'Samsung Galaxy Watch 5',
  'Samsung Galaxy Watch6': 'Samsung Galaxy Watch 6',
  'Samsung Z Flip 3': 'Samsung Galaxy Z Flip 3',
  'Samsung Z Flip 4': 'Samsung Galaxy Z Flip 4',
  'Samsung Z Flip 5': 'Samsung Galaxy Z Flip 5',
  'Samsung Galaxy Z Flip5': 'Samsung Galaxy Z Flip 5',
  'Samsung Galaxy Z Flip6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip 6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip 7': 'Samsung Galaxy Z Flip 7',
  'Sony CH520': 'Sony CH-520',
  'Sony Wireless Headphones': 'Sony Headphones',
  'Sony WH1000XM5': 'Sony WH-1000XM5',
  'Tecno Mega Pad': 'Tecno MegaPad',
  PS4: 'PlayStation 4',
  PS5: 'PlayStation 5',
}

// Light-touch only — catches trivial noise (case, whitespace, contraction
// apostrophes like "Founder's" vs "Founders") without doing any real semantic
// merging (e.g. "FE" vs "Founders Edition" still land as separate products).
// Deliberate deduplication across those is a later, human/AI-assisted phase.
export function normalizeVariantTier(raw: string): string {
  return raw.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ')
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

// Finer classification layer under each of the 14 PRODUCT_CATEGORIES above
// (categories.parent_id - see db/schema.sql's 2026-08-28 migration). Assigned
// unscoped by the product's category - scoping down to "only this category's
// children" would trust the very label a sub-category pass might need to
// correct (a product wrongly filed under Computers & Laptops that's really a
// Gaming PC would never see "Consoles"/"Graphics Cards" as options; an
// "Other" product would never see anything real at all). 'Other' itself is
// included as the 38th option (unlike PRODUCT_CATEGORIES, it isn't split
// further) so a genuinely-unclassifiable product still has a real,
// non-forced landing spot.
export const SUB_CATEGORIES = [
  'Smartphones',
  'Tablets',
  'Phone & Tablet Accessories',
  'Laptops',
  'Desktops',
  'Graphics Cards',
  'Processors & Motherboards',
  'Storage & Memory',
  'Power Supplies & Cases',
  'TVs',
  'Monitors',
  'Headphones & Earphones',
  'Speakers',
  'Consoles',
  'Games & Accessories',
  'Cameras',
  'Drones',
  'Camera Accessories',
  'Small Appliances',
  'Large Appliances',
  'Furniture',
  'Home Decor & Household Items',
  'Cars',
  'Motorcycles',
  'Bicycles',
  'Vehicle Parts & Accessories',
  'House & Lot',
  'Condo/Apartment',
  'Land',
  'Rentals',
  "Women's Clothing",
  "Men's Clothing",
  'Bags',
  'Shoes',
  'Exercise Equipment',
  'Outdoor & Camping Gear',
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

export interface CategoryBackfillCandidate {
  id: number
  base_model: string
  variant_tier: string | null
}

function formatCategoryBackfillLine(p: CategoryBackfillCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  return `[id: ${p.id}] ${label}`
}

export function buildCategoryBackfillPrompt(products: CategoryBackfillCandidate[]): string {
  const lines = products.map(formatCategoryBackfillLine).join('\n')
  return `For each product below, assign exactly one category from this fixed list:
${PRODUCT_CATEGORIES.join(', ')}

Use "Other" if none genuinely fit rather than forcing a bad match.

Products:
${lines}`
}

export const CATEGORY_BACKFILL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
        },
        required: ['id', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

export interface SubCategoryBackfillCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  category: string
}

function formatSubCategoryBackfillLine(p: SubCategoryBackfillCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  return `[id: ${p.id}] ${label} — currently filed under: ${p.category}`
}

// The product's current category is shown as context/a hint, not a
// constraint - see the SUB_CATEGORIES comment above for why the candidate
// list itself stays unscoped.
export function buildSubCategoryBackfillPrompt(products: SubCategoryBackfillCandidate[]): string {
  const lines = products.map(formatSubCategoryBackfillLine).join('\n')
  return `For each product below, assign exactly one sub-category from this fixed list:
${SUB_CATEGORIES.join(', ')}

Each product's current (coarser) category is shown for context, but may itself be wrong -
pick whichever sub-category on the fixed list actually fits best, even if that means
correcting the current category. Use "Other" if none genuinely fit rather than forcing a bad match.

Products:
${lines}`
}

export const SUB_CATEGORY_BACKFILL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sub_category: { type: 'string', enum: SUB_CATEGORIES },
        },
        required: ['id', 'sub_category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
