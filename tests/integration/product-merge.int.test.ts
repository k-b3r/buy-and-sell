import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { mergeDuplicateProducts } from '../../src/modules/catalog'

// Exercises mergeDuplicateProducts against the real
// products_base_model_variant_normalized_idx unique index, which the unit
// tests' scripted db can't enforce.

const pool = createDbPool(testDatabaseUrl())

const ALIAS = 'BUY39 PS'
const CANONICAL = 'Buy39 Console'
const EXISTING_CANONICAL = 'buy39  CONSOLE' // differs from CANONICAL only in case and spacing
const NORMALIZED = 'buy39 console'
const LISTING_ID = 'buy39-listing'

async function cleanup() {
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING_ID])
  await pool.query('DELETE FROM products WHERE base_model = ANY($1)', [[ALIAS, CANONICAL, EXISTING_CANONICAL]])
}

beforeEach(cleanup)

afterAll(async () => {
  await cleanup()
  await pool.end()
})

async function insertProduct(baseModel: string, baseModelNormalized: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier, variant_tier_normalized)
     VALUES ($1, $2, 'Slim', 'slim') RETURNING id`,
    [baseModel, baseModelNormalized],
  )
  return (result.rows[0] as { id: number }).id
}

test('mergeDuplicateProducts merges into an existing canonical row that differs only in case and spacing instead of hitting the unique index', async () => {
  const existingId = await insertProduct(EXISTING_CANONICAL, NORMALIZED)
  const aliasId = await insertProduct(ALIAS, 'buy39 ps')
  await pool.query(
    `INSERT INTO listings (id, title, raw_json, product_id) VALUES ($1, 'BUY39 Console Slim', '{}', $2)`,
    [LISTING_ID, aliasId],
  )

  const result = await mergeDuplicateProducts(pool, { canonicalMap: { [ALIAS]: CANONICAL } })

  expect(result).toEqual({ renamed: 0, merged: 1 })
  const products = await pool.query('SELECT id FROM products WHERE id = ANY($1) ORDER BY id', [[existingId, aliasId]])
  expect(products.rows).toEqual([{ id: existingId }])
  const listing = await pool.query('SELECT product_id FROM listings WHERE id = $1', [LISTING_ID])
  expect(listing.rows).toEqual([{ product_id: existingId }])
})
