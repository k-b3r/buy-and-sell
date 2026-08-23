import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDbPool, flagPriceLookupExcluded } from './db'

// Manually curated (2026-08-23) from a real scan of distinct products.base_model
// values — "new-retail price" is a meaningless concept for these, so both
// new-price-lookup.ts (Exa, costs money) and price-lookup.ts (Gemini, burns
// quota) waste a call on them otherwise. Re-run whenever a new batch of
// extraction turns up more junk categories — idempotent, matches on
// base_model text.
export const PRICE_INELIGIBLE_CATEGORIES: Record<string, string[]> = {
  real_estate: [
    'Apartment',
    'Condo',
    'Condo Unit',
    'Condominium',
    'Condominium Unit',
    'House',
    'House & Lot',
    'House and Lot',
    'House and Rights',
    'Land Lot',
    'Lot',
    'Property',
    // Specific PH condo/house project names — same wrong domain as the
    // generic entries above, just not caught by exact-string matching until
    // a full pending-candidate scan surfaced them (2026-08-23).
    '1 Bedroom Condo Unit',
    'Ancestral House',
    'Arya Residences Penthouse',
    'Commercial House',
    'Commercial Space',
    'Fort Victoria Condo Unit',
    'GA Tower Condo Unit',
    'Grass Residences Condo Unit',
    'R Square Residences Condo Unit',
    'SMDC Breeze Residences Condo Unit',
    'Townhouse',
    'Warehouse and Lot',
  ],
  too_generic: [
    'Item',
    'Unidentified Product',
    'Unknown Product',
    'Bundle',
    'Electronics',
    'Electronics Bundle',
    'GPU',
    'Laptop',
    'Phone',
    'Watch',
    'Bag',
    'Shoes',
    'Clothing',
    'Jewelry',
    'Assorted Makeup',
    'Car',
    'Bicycle',
    'Bike',
    'Motorcycle',
    'Appliance',
    'Appliances',
    'Furniture and Appliances',
    'Speaker',
    // Bare component category, no brand/chipset/model — same problem as bare
    // 'GPU' above. Found live 2026-08-23: 'CPU' returned ₱11,095-38,090 (3.4x),
    // 'Intel Motherboard' ₱3,750-30,195 (8x), 'AM4 Motherboard' ₱3,395-20,495
    // (6x, spans budget A320 to high-end X570) — each spread spans an entire
    // product tier, not one product.
    'CPU',
    'Intel Motherboard',
    'AM4 Motherboard',
    'Household Appliances',
    'Household Furniture',
    'Power Supply Unit',
  ],
  // Unlike too_generic (no recoverable path — genuinely not a real, single
  // product), these ARE real, priceable products — they just need a pricing
  // strategy that doesn't exist yet: per-component pricing summed together
  // (see CONTEXT.md, 2026-08-23). Found live: "Gaming PC Set" returned a
  // "high confidence" ₱40,800-414,995 range, each number individually real
  // but grounded to totally different unrelated prebuilts, since a single
  // price range across arbitrary configurations is meaningless. Kept as a
  // distinct reason (not folded into too_generic) so this specific group is
  // queryable and can be revisited once that feature exists — query
  // `WHERE price_lookup_excluded_reason = 'needs_component_pricing'`.
  // 'CPU Motherboard Bundle'/'CPU Motherboard RAM Bundle' belong here too —
  // found live 2026-08-23: both returned the identical ₱4,895-58,140 (12x)
  // range, Exa clearly grounding to the general "PC parts bundle" market
  // rather than any specific bundle.
  needs_component_pricing: [
    'Desktop PC Setup',
    'Gaming PC Set',
    'Gaming PC Setup',
    'Gaming Setup',
    'PC Set',
    'Pre-built PC',
    'CPU Motherboard Bundle',
    'CPU Motherboard RAM Bundle',
    'AM4 System Unit',
    'Computer System Unit Core i5-7400',
    'Computer System Unit Core i7-4790',
    'Desktop System Unit',
    'Gaming PC System Unit',
    'Gaming System Unit',
    'PC System Unit',
    'PC Unit',
    'Ryzen 3 3200G System Unit',
    'Ryzen System Unit',
  ],
  parts_accessory: [
    'Bicycle Accessories',
    'Bicycle Fork',
    'Bicycle Frame',
    'Bicycle Parts',
    'Bicycle Parts Bundle',
    'Camera Bag',
    'Camera Lens',
    'Car Audio Amplifier',
    'Car Audio System',
    'Car Fog Lamp',
    'Car Lights',
    'Car Part',
    'Car Seat',
    'Car Stereo',
    'Car Wheels',
    'Laptop Bag',
    'Laptop Cooler',
    'Laptop RAM',
    'Motorcycle Accessories',
    'Motorcycle Gas Tank',
    'Motorcycle Parts',
    'Motorcycle Raincoat',
    'Motorcycle Raincoat Suit',
    'Motorcycle Sidecar',
    'Motorcycle Top Box',
    'Motorcycle Wheel Mags',
    'Phone Case',
    'Phone Part',
    'Speaker Box',
  ],
  service: ['Phone Upgrade Service'],
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const pool = createDbPool(dbUrl)
  try {
    for (const [reason, baseModels] of Object.entries(PRICE_INELIGIBLE_CATEGORIES)) {
      await flagPriceLookupExcluded(pool, baseModels, reason)
      console.log(`flagged ${baseModels.length} base_model values as '${reason}'`)
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
