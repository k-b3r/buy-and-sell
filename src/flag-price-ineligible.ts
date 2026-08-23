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
    // Assembled/build-varies bundles — a single price range across these is
    // meaningless (found live 2026-08-23: "Gaming PC Set" returned a
    // "high confidence" ₱40,800-414,995 range, each number individually real
    // but grounded to totally different unrelated prebuilts — the product's
    // own Groq enrichment already says "configurations vary widely, exact
    // components define its value", this just wasn't wired to the exclusion
    // check).
    'Desktop PC Setup',
    'Gaming PC Set',
    'Gaming PC Setup',
    'Gaming Setup',
    'PC Set',
    'Pre-built PC',
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
