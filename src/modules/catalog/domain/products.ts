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

// The one check every LLM response path (extraction, enrichment, both
// backfills) runs before trusting a category name it was handed.
export function isProductCategory(value: unknown): value is (typeof PRODUCT_CATEGORIES)[number] {
  return typeof value === 'string' && (PRODUCT_CATEGORIES as readonly string[]).includes(value)
}

export function isSubCategory(value: unknown): value is (typeof SUB_CATEGORIES)[number] {
  return typeof value === 'string' && (SUB_CATEGORIES as readonly string[]).includes(value)
}
