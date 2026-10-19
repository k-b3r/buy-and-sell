import { applyTriageVerdicts } from './price-triage'
import type { DbClient } from '../../../platform/storage'

function triageDb(rows: { product_id?: number; previous_reason?: string }[]): { db: DbClient; sqls: string[] } {
  const sqls: string[] = []
  return {
    sqls,
    db: {
      query: async (sql: string) => {
        sqls.push(sql)
        return {
          rows: sql.includes('SELECT DISTINCT previous_reason') || sql.includes('SELECT product_id') ? rows : [],
        }
      },
    },
  }
}

test('applyTriageVerdicts includes each retry product, then marks it applied, and returns the count', async () => {
  const { db, sqls } = triageDb([{ product_id: 5 }])

  const applied = await applyTriageVerdicts(db, 'high')

  expect(applied).toBe(1)
  expect(sqls).toHaveLength(3)
  expect(sqls[0]).toContain('SELECT product_id FROM product_pricing_triage')
  expect(sqls[1]).toContain('INSERT INTO price_exclusion_overrides')
  expect(sqls[2]).toContain('UPDATE product_pricing_triage SET applied_at = now()')
})

test('applyTriageVerdicts rejects a reason no triage row carries before changing anything', async () => {
  const { db, sqls } = triageDb([{ previous_reason: 'too_generic' }])

  await expect(applyTriageVerdicts(db, 'high', ['too_genreic'])).rejects.toThrow(
    'unknown reason(s): too_genreic. Triaged reasons: too_generic',
  )
  expect(sqls).toHaveLength(1)
})
