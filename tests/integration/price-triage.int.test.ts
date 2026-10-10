import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { applyTriageVerdicts, getTriageCandidates, saveTriageRows } from '../../src/modules/pricing'

const pool = createDbPool(testDatabaseUrl())

const SPECIFIC = 9301
const GENERIC = 9302
const UNSURE = 9303
const IDS = [SPECIFIC, GENERIC, UNSURE]

async function clearFixtures(): Promise<void> {
  await pool.query("DELETE FROM listings WHERE id LIKE 'triage-fx-%'")
  await pool.query('DELETE FROM products WHERE id = ANY($1)', [IDS])
}

async function state(id: number): Promise<{ excluded: boolean; applied: boolean }> {
  const { rows } = (await pool.query(
    `SELECT p.price_lookup_excluded AS excluded, t.applied_at IS NOT NULL AS applied
     FROM products p LEFT JOIN product_pricing_triage t ON t.product_id = p.id WHERE p.id = $1`,
    [id],
  )) as { rows: { excluded: boolean; applied: boolean }[] }
  return rows[0]
}

const row = (
  productId: number,
  verdict: 'retry' | 'keep_excluded',
  confidence: 'high' | 'medium' | 'low',
  previousReason = 'retail_not_found',
) => ({
  productId,
  previousReason,
  verdict,
  isSpecificProduct: verdict === 'retry',
  confidence,
  priceLow: verdict === 'retry' ? 1000 : null,
  priceHigh: verdict === 'retry' ? 2000 : null,
  reasoning: 'fixture',
})

beforeEach(async () => {
  await clearFixtures()
  for (const [id, name] of [
    [SPECIFIC, 'Triage Fixture Phone'],
    [GENERIC, 'Triage Fixture Stuff'],
    [UNSURE, 'Triage Fixture Thing'],
  ] as const) {
    await pool.query(
      `INSERT INTO products (id, base_model, base_model_normalized, price_lookup_excluded, price_lookup_excluded_reason)
       VALUES ($1, $2, lower($2), true, 'retail_not_found')`,
      [id, name],
    )
  }
  for (const [i, price] of [1000, 2000, 3000].entries()) {
    await pool.query(
      `INSERT INTO listings (id, title, price_amount, product_id, raw_json) VALUES ($1, $2, $3, $4, '{}')`,
      [`triage-fx-${i}`, `Triage phone listing ${i}`, price, SPECIFIC],
    )
  }
})

afterAll(async () => {
  await clearFixtures()
  await pool.end()
})

test('triage candidates are excluded, untriaged products with their listing evidence', async () => {
  const candidates = (await getTriageCandidates(pool, 10_000)).filter((c) => IDS.includes(c.id))

  const phone = candidates.find((c) => c.id === SPECIFIC)
  expect(phone).toMatchObject({ reason: 'retail_not_found', listing_count: 3, median_ask: 2000 })
  expect(phone?.sample_titles).toHaveLength(3)
  expect(candidates.map((c) => c.id)).toEqual(expect.arrayContaining(IDS))
})

test('a triaged product is no longer a candidate, so a rerun resumes where it stopped', async () => {
  await saveTriageRows(pool, [row(SPECIFIC, 'retry', 'high')])

  const ids = (await getTriageCandidates(pool, 10_000)).map((c) => c.id)
  expect(ids).not.toContain(SPECIFIC)
  expect(ids).toContain(GENERIC)
})

test('applying verdicts includes only retry verdicts at or above the confidence bar, once', async () => {
  await saveTriageRows(pool, [
    row(SPECIFIC, 'retry', 'high'),
    row(GENERIC, 'keep_excluded', 'high'),
    row(UNSURE, 'retry', 'low'),
  ])

  const first = await applyTriageVerdicts(pool, 'medium')
  const second = await applyTriageVerdicts(pool, 'medium')

  expect(await state(SPECIFIC)).toEqual({ excluded: false, applied: true })
  expect(await state(GENERIC)).toEqual({ excluded: true, applied: false })
  expect(await state(UNSURE)).toEqual({ excluded: true, applied: false })
  expect(first).toBeGreaterThanOrEqual(1)
  expect(second).toBe(0)
})

test('applying with a reasons list includes only retries whose old reason is listed', async () => {
  await saveTriageRows(pool, [
    row(SPECIFIC, 'retry', 'high', 'retail_not_found'),
    row(GENERIC, 'retry', 'high', 'groq_generic'),
  ])

  await applyTriageVerdicts(pool, 'high', ['retail_not_found'])

  expect(await state(SPECIFIC)).toEqual({ excluded: false, applied: true })
  expect(await state(GENERIC)).toEqual({ excluded: true, applied: false })
})

test('applying never overturns a human manual_review exclusion, even when it is listed', async () => {
  await saveTriageRows(pool, [row(UNSURE, 'retry', 'high', 'manual_review')])

  await applyTriageVerdicts(pool, 'high', ['manual_review'])
  await applyTriageVerdicts(pool, 'high')

  expect(await state(UNSURE)).toEqual({ excluded: true, applied: false })
})
