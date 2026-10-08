import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { getProductDetail, getProductSummaries } from '../../src/modules/catalog'
import {
  applyEligibilityFromEnrichment,
  excludeFromPricing,
  excludeProductFromReview,
  getExcludedProducts,
  getExclusionSummary,
  getPriceLookupCandidates,
  includeInPricing,
} from '../../src/modules/pricing'

const pool = createDbPool(testDatabaseUrl())

const JUDGED = 9201
const LOOKUP = 9202
const LEGACY = 9203
const IDS = [JUDGED, LOOKUP, LEGACY]

async function clearFixtures(): Promise<void> {
  await pool.query("DELETE FROM listings WHERE id = 'excl-fx-1'")
  await pool.query('DELETE FROM product_enrichment WHERE product_id = ANY($1)', [IDS])
  await pool.query('DELETE FROM products WHERE id = ANY($1)', [IDS])
}

async function excludedState(
  id: number,
): Promise<{ excluded: boolean; reason: string | null; override: string | null }> {
  const { rows } = (await pool.query(
    `SELECT p.price_lookup_excluded AS excluded, p.price_lookup_excluded_reason AS reason, o.previous_reason AS override
     FROM products p LEFT JOIN price_exclusion_overrides o ON o.product_id = p.id WHERE p.id = $1`,
    [id],
  )) as { rows: { excluded: boolean; reason: string | null; override: string | null }[] }
  return rows[0]
}

beforeEach(async () => {
  await clearFixtures()
  for (const [id, name, reason] of [
    [JUDGED, 'Exclusion Fixture Judged', 'groq_generic'],
    [LOOKUP, 'Exclusion Fixture Lookup', 'retail_not_found'],
    [LEGACY, 'Exclusion Fixture Legacy', 'exa_no_result'],
  ] as const) {
    await pool.query(
      `INSERT INTO products (id, base_model, base_model_normalized, price_lookup_excluded, price_lookup_excluded_reason)
       VALUES ($1, $2, lower($2), true, $3)`,
      [id, name, reason],
    )
  }
  // Product summaries only list products with live listings.
  await pool.query(
    `INSERT INTO listings (id, title, price_amount, product_id, raw_json) VALUES ('excl-fx-1', 'fixture', 1000, $1, '{}')`,
    [JUDGED],
  )
  // The LLM's "not a specific product" verdict that applyEligibilityFromEnrichment re-applies every lap.
  await pool.query(
    `INSERT INTO product_enrichment (product_id, description, value_drivers, has_trained_price_knowledge, model,
       is_specific_product, confidence)
     VALUES ($1, 'd', 'v', false, 'm', false, 'high')`,
    [JUDGED],
  )
})

afterAll(async () => {
  await clearFixtures()
  await pool.end()
})

test('including a judgment exclusion records an override that survives the next enrichment lap', async () => {
  await includeInPricing(pool, JUDGED)
  expect(await excludedState(JUDGED)).toEqual({ excluded: false, reason: null, override: 'groq_generic' })

  await applyEligibilityFromEnrichment(pool)
  expect((await excludedState(JUDGED)).excluded).toBe(false)
})

test('an overridden product is skipped by the curated lists and the live heuristic', async () => {
  await includeInPricing(pool, JUDGED)

  await excludeFromPricing(pool, { baseModels: ['Exclusion Fixture Judged'] }, 'too_generic')
  await excludeFromPricing(pool, { productId: JUDGED }, 'too_generic')

  expect((await excludedState(JUDGED)).excluded).toBe(false)
})

test('a manual exclusion removes the override so the human decision wins', async () => {
  await includeInPricing(pool, JUDGED)

  await excludeProductFromReview(pool, JUDGED, 'manual_review')

  expect(await excludedState(JUDGED)).toEqual({ excluded: true, reason: 'manual_review', override: null })
})

test('including a lookup-outcome exclusion is a retry: no override, back in the lookup queue, re-excludable', async () => {
  await includeInPricing(pool, LOOKUP)
  await includeInPricing(pool, LEGACY)

  expect(await excludedState(LOOKUP)).toEqual({ excluded: false, reason: null, override: null })
  expect(await excludedState(LEGACY)).toEqual({ excluded: false, reason: null, override: null })
  const candidateIds = (await getPriceLookupCandidates(pool)).map((c) => c.id)
  expect(candidateIds).toEqual(expect.arrayContaining([LOOKUP, LEGACY]))

  await excludeFromPricing(pool, { productId: LOOKUP }, 'retail_not_found')
  expect((await excludedState(LOOKUP)).excluded).toBe(true)
})

test('including a product that is not excluded changes nothing', async () => {
  await includeInPricing(pool, JUDGED)
  await includeInPricing(pool, JUDGED)

  expect(await excludedState(JUDGED)).toEqual({ excluded: false, reason: null, override: 'groq_generic' })
})

test('the exclusion summary counts products per reason and marks lookup outcomes as retryable', async () => {
  const summary = await getExclusionSummary(pool)

  expect(summary).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: 'groq_generic', retry: false }),
      expect.objectContaining({ reason: 'retail_not_found', retry: true }),
      expect.objectContaining({ reason: 'exa_no_result', retry: true }),
    ]),
  )
  for (const row of summary) expect(row.count).toBeGreaterThan(0)
})

test('excluded products are listed by reason', async () => {
  const products = await getExcludedProducts(pool, 'groq_generic', { limit: 500 })

  expect(products.map((p) => p.id)).toContain(JUDGED)
  expect(products.find((p) => p.id === JUDGED)).toMatchObject({ base_model: 'Exclusion Fixture Judged' })
})

test('product detail and summaries expose the exclusion reason, null once included', async () => {
  expect((await getProductDetail(pool, JUDGED))?.pricing_excluded_reason).toBe('groq_generic')
  expect((await getProductSummaries(pool, { search: 'Exclusion Fixture Judged' }))[0].pricing_excluded_reason).toBe(
    'groq_generic',
  )

  await includeInPricing(pool, JUDGED)

  expect((await getProductDetail(pool, JUDGED))?.pricing_excluded_reason).toBeNull()
  expect(
    (await getProductSummaries(pool, { search: 'Exclusion Fixture Judged' }))[0].pricing_excluded_reason,
  ).toBeNull()
})
