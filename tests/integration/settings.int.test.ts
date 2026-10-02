import { testDatabaseUrl } from './global-setup'
import { loadSettings, SETTING_DEFAULTS } from '../../src/platform/settings'
import { createDbPool } from '../../src/platform/storage'

const pool = createDbPool(testDatabaseUrl())

afterAll(() => pool.end())

test('loadSettings reads values seeded by schema.sql from the real settings table', async () => {
  const settings = await loadSettings(pool, ['extract_real_estate.batch_size'])

  expect(settings).toEqual({ 'extract_real_estate.batch_size': 10 })
})

test('loadSettings returns an operator-edited value over the code default', async () => {
  const key = Object.keys(SETTING_DEFAULTS)[0]
  const edited = SETTING_DEFAULTS[key] + 1
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, edited],
  )

  const settings = await loadSettings(pool, [key])

  expect(settings[key]).toBe(edited)
})

test('loadSettings falls back to SETTING_DEFAULTS for a key with no row', async () => {
  const key = Object.keys(SETTING_DEFAULTS)[0]
  await pool.query('DELETE FROM settings WHERE key = $1', [key])

  const settings = await loadSettings(pool, [key])

  expect(settings[key]).toBe(SETTING_DEFAULTS[key])
})
