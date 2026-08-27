import { mergeDuplicateProducts } from './index'
import type { DbClient } from '../../storage/client'

function scriptedDb(script: (sql: string, params: unknown[]) => unknown): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return script(sql, params)
      },
    },
  }
}

test('renames a product with no collision at the canonical name', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier')) return { rows: [{ id: 1698, variant_tier: null }] }
    if (sql.startsWith('SELECT id FROM products WHERE base_model = $1')) return { rows: [] } // no collision
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 1, merged: 0 })
  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE products SET base_model'))
  expect(updateCall?.params).toEqual(['PlayStation 4', 'playstation 4', 1698])
})

test('merges into the existing canonical row instead of renaming when one already exists with the same variant', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier')) return { rows: [{ id: 1698, variant_tier: null }] }
    if (sql.startsWith('SELECT id FROM products WHERE base_model = $1')) return { rows: [{ id: 532 }] } // collision: PlayStation 4 / null already exists as id 532
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 0, merged: 1 })
  const listingsReassign = calls.find((c) => c.sql.includes('UPDATE listings SET product_id'))
  expect(listingsReassign?.params).toEqual([532, 1698])
  const deleteLoser = calls.find((c) => c.sql === 'DELETE FROM products WHERE id = $1')
  expect(deleteLoser?.params).toEqual([1698])
})

test('processes multiple alias rows for the same canonical independently', async () => {
  const { db } = scriptedDb((sql, params) => {
    if (sql.startsWith('SELECT id, variant_tier')) {
      return {
        rows: [
          { id: 1505, variant_tier: 'Slim' },
          { id: 1698, variant_tier: null },
          { id: 433, variant_tier: 'Pro' },
        ],
      }
    }
    if (sql.startsWith('SELECT id FROM products WHERE base_model = $1')) {
      const variant = params[1]
      if (variant === 'Slim') return { rows: [{ id: 499 }] } // collides with PlayStation 4 / Slim
      if (variant === null) return { rows: [{ id: 532 }] } // collides with PlayStation 4 / null
      return { rows: [] } // Pro: no collision, safe rename
    }
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 1, merged: 2 })
})
