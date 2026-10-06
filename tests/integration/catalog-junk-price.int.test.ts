import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { getProductSummaries, getSoldCountsBySubCategory } from '../../src/modules/catalog'

// A ₱50 ask is junk (below the floor) yet passes the magnitude-outlier band
// against a ₱400 median, so only the junk-price rule keeps it out of the
// product list's price range and the sold chart's weekly average.

const pool = createDbPool(testDatabaseUrl())

const PRODUCT = 9101
const MAIN_CATEGORY = 'Junk Fixture Main'
const SUB_CATEGORY = 'Junk Fixture Sub'

const LISTINGS: { id: string; price: number; sold: boolean }[] = [
  { id: 'jp-a1', price: 50, sold: false },
  { id: 'jp-a2', price: 300, sold: false },
  { id: 'jp-a3', price: 400, sold: false },
  { id: 'jp-a4', price: 500, sold: false },
  { id: 'jp-s1', price: 50, sold: true },
  { id: 'jp-s2', price: 1000, sold: true },
]
const LISTING_IDS = LISTINGS.map((l) => l.id)

async function clearFixtures(): Promise<void> {
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [LISTING_IDS])
  await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT])
  await pool.query('DELETE FROM categories WHERE name = $1', [SUB_CATEGORY])
  await pool.query('DELETE FROM categories WHERE name = $1', [MAIN_CATEGORY])
}

beforeAll(async () => {
  await clearFixtures()
  await pool.query('INSERT INTO categories (name) VALUES ($1)', [MAIN_CATEGORY])
  await pool.query(
    'INSERT INTO categories (name, parent_id) VALUES ($1, (SELECT id FROM categories WHERE name = $2))',
    [SUB_CATEGORY, MAIN_CATEGORY],
  )
  await pool.query(
    `INSERT INTO products (id, base_model, base_model_normalized, category_id, sub_category_id)
     VALUES ($1, 'Junk Fixture Gadget', 'junk fixture gadget',
       (SELECT id FROM categories WHERE name = $2), (SELECT id FROM categories WHERE name = $3))`,
    [PRODUCT, MAIN_CATEGORY, SUB_CATEGORY],
  )
  for (const l of LISTINGS) {
    await pool.query(
      `INSERT INTO listings (id, title, price_amount, product_id, sold_at, raw_json)
       VALUES ($1, 'Junk Fixture Gadget', $2, $3, CASE WHEN $4 THEN now() END, '{}')`,
      [l.id, l.price, PRODUCT, l.sold],
    )
  }
})

afterAll(async () => {
  await clearFixtures()
  await pool.end()
})

test('product list price range leaves out a junk price below the floor', async () => {
  const [summary] = await getProductSummaries(pool, { search: 'Junk Fixture Gadget' })

  expect({ min: summary?.price_min, max: summary?.price_max, avg: summary?.price_avg }).toEqual({
    min: 300,
    max: 500,
    avg: 400,
  })
})

test('sold chart weekly average leaves out a junk price below the floor', async () => {
  const groups = await getSoldCountsBySubCategory(pool)
  const group = groups.find((g) => g.category === MAIN_CATEGORY && g.subCategory === SUB_CATEGORY)
  const soldWeeks = (group?.weeklyCounts ?? []).filter((w) => w.count > 0)

  expect(soldWeeks.map((w) => ({ count: w.count, avgPrice: w.avgPrice }))).toEqual([{ count: 2, avgPrice: 1000 }])
})
