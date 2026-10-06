import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import { computeRepostIds, repostKey, repostKeySql } from '../../src/modules/pricing'

// repostKeySql (deals page) and repostKey (product page) are the two sides
// of one rule; this checks they agree on shared fixtures, including titles
// padded with tabs, newlines and non-breaking spaces.

const pool = createDbPool(testDatabaseUrl())

const LISTINGS: { id: string; title: string | null }[] = [
  { id: 'rp-1', title: 'iPhone 13 256GB' },
  { id: 'rp-2', title: '  iphone 13 256gb  ' },
  { id: 'rp-3', title: 'IPHONE 13 256GB' },
  { id: 'rp-4', title: 'iPhone 13 128GB' },
  { id: 'rp-7', title: '\t iPhone 13 256GB\u00a0\n' },
  { id: 'rp-8', title: '\u3000iPhone 13 128GB\r\n' },
  { id: 'rp-9', title: 'iPhone\u00a013 64GB' },
  { id: 'rp-5', title: null },
  { id: 'rp-6', title: null },
]
const IDS = LISTINGS.map((l) => l.id)

beforeAll(async () => {
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [IDS])
  for (const l of LISTINGS) {
    await pool.query(`INSERT INTO listings (id, title, raw_json) VALUES ($1, $2, '{}')`, [l.id, l.title])
  }
})

afterAll(async () => {
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [IDS])
  await pool.end()
})

test('repostKeySql computes the same key as repostKey for every fixture listing', async () => {
  const result = await pool.query(`SELECT id, ${repostKeySql('title', 'id')} AS key FROM listings WHERE id = ANY($1)`, [
    IDS,
  ])
  const sqlKeys = Object.fromEntries((result.rows as { id: string; key: string }[]).map((r) => [r.id, r.key]))

  expect(sqlKeys).toEqual(Object.fromEntries(LISTINGS.map((l) => [l.id, repostKey(l)])))
})

test('grouping by repostKeySql finds the same repost listings as computeRepostIds', async () => {
  const result = await pool.query(
    `SELECT id FROM listings l
     WHERE id = ANY($1)
       AND (SELECT count(*) FROM listings o WHERE o.id = ANY($1) AND ${repostKeySql('o.title', 'o.id')} = ${repostKeySql('l.title', 'l.id')}) > 1`,
    [IDS],
  )
  const sqlRepostIds = new Set((result.rows as { id: string }[]).map((r) => r.id))

  expect(sqlRepostIds).toEqual(computeRepostIds(LISTINGS))
})
