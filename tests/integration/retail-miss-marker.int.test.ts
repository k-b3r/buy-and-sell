import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { getProductsNeedingReview } from '../../src/modules/catalog'
import { getPriceLookupCandidates } from '../../src/modules/pricing'
import { recordRetailMissForOverridden } from '../../src/modules/pricing/store/price-history'

const pool = createDbPool(testDatabaseUrl())

const OVERRIDDEN = 9301
const PLAIN = 9302
const IDS = [OVERRIDDEN, PLAIN]

async function markerCount(id: number): Promise<number> {
  const { rows } = (await pool.query(
    "SELECT count(*)::int AS n FROM product_price_history WHERE product_id = $1 AND source = 'retail_not_found'",
    [id],
  )) as { rows: { n: number }[] }
  return rows[0].n
}

async function clear(): Promise<void> {
  await pool.query('DELETE FROM product_price_history WHERE product_id = ANY($1)', [IDS])
  await pool.query('DELETE FROM products WHERE id = ANY($1)', [IDS])
}

beforeEach(async () => {
  await clear()
  for (const id of IDS) {
    await pool.query(`INSERT INTO products (id, base_model, base_model_normalized) VALUES ($1, $2, lower($2))`, [
      id,
      `Retail Miss Fixture ${id}`,
    ])
  }
  await pool.query("INSERT INTO price_exclusion_overrides (product_id, previous_reason) VALUES ($1, 'groq_generic')", [
    OVERRIDDEN,
  ])
})

afterAll(async () => {
  await clear()
  await pool.end()
})

test('writes a marker only for an overridden product, once per call, and the lookup stops selecting it', async () => {
  const candidates = async () => (await getPriceLookupCandidates(pool)).map((c) => c.id)
  expect(await candidates()).toContain(OVERRIDDEN)

  await recordRetailMissForOverridden(pool, OVERRIDDEN)
  await recordRetailMissForOverridden(pool, PLAIN)

  expect(await markerCount(OVERRIDDEN)).toBe(1)
  expect(await markerCount(PLAIN)).toBe(0)
  expect(await candidates()).not.toContain(OVERRIDDEN)
  expect(await candidates()).toContain(PLAIN)
})

test('the review queue price_history JSON hides the marker row', async () => {
  await pool.query("UPDATE products SET price_lookup_review_status = 'needs_review' WHERE id = $1", [OVERRIDDEN])
  await recordRetailMissForOverridden(pool, OVERRIDDEN)
  await pool.query(
    `INSERT INTO product_price_history (product_id, source, price_low, price_high, price_currency)
     VALUES ($1, 'manual_new_retail', 100, 200, 'PHP')`,
    [OVERRIDDEN],
  )

  const row = (await getProductsNeedingReview(pool)).find((r) => r.id === OVERRIDDEN)

  expect(row?.price_history.map((h) => h.source)).toEqual(['manual_new_retail'])
})
