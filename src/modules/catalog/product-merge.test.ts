import { mergeDuplicateProducts, mergeProductVariantAliases } from './product-merge'
import type { DbClient } from '../../platform/storage'

function scriptedDb(script: (sql: string, params: unknown[]) => unknown): {
  db: DbClient
  calls: { sql: string; params: unknown[] }[]
} {
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

const FIND_SQL =
  'SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2'

test('renames base+variant to canonical when nothing collides (variant moves from base into tier)', async () => {
  const { db, calls } = scriptedDb((sql, params) => {
    if (sql === FIND_SQL) {
      const [base, variant] = params
      if (base === 'iphone 14 plus' && variant === null) return { rows: [{ id: 1698 }] } // the alias row itself
      return { rows: [] } // canonical target has no existing row
    }
    return { rows: [] }
  })

  const result = await mergeProductVariantAliases(db, [
    { aliasBase: 'iPhone 14 Plus', aliasVariant: null, canonicalBase: 'iPhone 14', canonicalVariant: 'Plus' },
  ])

  expect(result).toEqual({ renamed: 1, merged: 0, noMatch: [] })
  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE products SET'))
  expect(updateCall?.params).toEqual(['iPhone 14', 'iphone 14', 'Plus', 'plus', 1698])
})

test('merges into existing canonical row instead of renaming when the target already exists', async () => {
  const { db, calls } = scriptedDb((sql, params) => {
    if (sql === FIND_SQL) {
      const [base, variant] = params
      if (base === 'ps4 slim' && variant === null) return { rows: [{ id: 1698 }] }
      if (base === 'playstation 4' && variant === 'slim') return { rows: [{ id: 532 }] }
      return { rows: [] }
    }
    return { rows: [] }
  })

  const result = await mergeProductVariantAliases(db, [
    { aliasBase: 'PS4 Slim', aliasVariant: null, canonicalBase: 'PlayStation 4', canonicalVariant: 'Slim' },
  ])

  expect(result).toEqual({ renamed: 0, merged: 1, noMatch: [] })
  const listingsReassign = calls.find((c) => c.sql.includes('UPDATE listings SET product_id'))
  expect(listingsReassign?.params).toEqual([532, 1698])
  const deleteLoser = calls.find((c) => c.sql === 'DELETE FROM products WHERE id = $1')
  expect(deleteLoser?.params).toEqual([1698])
})

test('matching is case-insensitive (normalized), so casing typos in the rule still match live data', async () => {
  const { db, calls } = scriptedDb((sql, params) => {
    if (sql === FIND_SQL) {
      const [base, variant] = params
      if (base === 'vivo v40 lite' && variant === null) return { rows: [{ id: 1698 }] }
      return { rows: [] }
    }
    return { rows: [] }
  })

  const result = await mergeProductVariantAliases(db, [
    { aliasBase: 'VIVO v40 LITE', aliasVariant: null, canonicalBase: 'Vivo V40', canonicalVariant: 'Lite' },
  ])

  expect(result).toEqual({ renamed: 1, merged: 0, noMatch: [] })
  expect(calls.some((c) => c.sql.startsWith('UPDATE products SET'))).toBe(true)
})

test('reports a rule as noMatch when the alias row does not exist, instead of touching anything', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql === FIND_SQL) return { rows: [] }
    return { rows: [] }
  })

  const rule = {
    aliasBase: 'Nonexistent Product',
    aliasVariant: null,
    canonicalBase: 'Something Else',
    canonicalVariant: null,
  }
  const result = await mergeProductVariantAliases(db, [rule])

  expect(result).toEqual({ renamed: 0, merged: 0, noMatch: [rule] })
  expect(calls.some((c) => c.sql.startsWith('UPDATE') || c.sql.startsWith('DELETE'))).toBe(false)
})

test('dry run reports the same counts without issuing any UPDATE/DELETE', async () => {
  const { db, calls } = scriptedDb((sql, params) => {
    if (sql === FIND_SQL) {
      const [base, variant] = params
      if (base === 'iphone 14 plus' && variant === null) return { rows: [{ id: 1698 }] }
      return { rows: [] }
    }
    return { rows: [] }
  })

  const result = await mergeProductVariantAliases(
    db,
    [{ aliasBase: 'iPhone 14 Plus', aliasVariant: null, canonicalBase: 'iPhone 14', canonicalVariant: 'Plus' }],
    { dryRun: true },
  )

  expect(result).toEqual({ renamed: 1, merged: 0, noMatch: [] })
  expect(calls.some((c) => c.sql.startsWith('UPDATE') || c.sql.startsWith('DELETE'))).toBe(false)
})

test('processes multiple alias rows sharing the same canonical target independently, order-independent via live requery', async () => {
  // Two separate aliases both fold into "PlayStation 4 / Slim", neither pre-existing as that canonical.
  const state = { canonicalExists: false }
  const { db } = scriptedDb((sql, params) => {
    if (sql === FIND_SQL) {
      const [base, variant] = params
      if (base === 'ps4 slim' && variant === null) return { rows: [{ id: 1698 }] }
      if (base === 'ps4' && variant === 'slim') return { rows: [{ id: 1505 }] }
      if (base === 'playstation 4' && variant === 'slim')
        return state.canonicalExists ? { rows: [{ id: 1698 }] } : { rows: [] }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE products SET')) {
      state.canonicalExists = true
      return { rows: [] }
    }
    return { rows: [] }
  })

  const result = await mergeProductVariantAliases(db, [
    { aliasBase: 'PS4 Slim', aliasVariant: null, canonicalBase: 'PlayStation 4', canonicalVariant: 'Slim' },
    { aliasBase: 'PS4', aliasVariant: 'Slim', canonicalBase: 'PlayStation 4', canonicalVariant: 'Slim' },
  ])

  expect(result).toEqual({ renamed: 1, merged: 1, noMatch: [] })
})

test('mergeDuplicateProducts renames a product with no collision at the canonical name', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier_normalized'))
      return { rows: [{ id: 1698, variant_tier_normalized: null }] }
    if (sql === FIND_SQL) return { rows: [] } // no collision
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 1, merged: 0 })
  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE products SET base_model'))
  expect(updateCall?.params).toEqual(['PlayStation 4', 'playstation 4', 1698])
})

test('mergeDuplicateProducts looks up the canonical row by normalized base model and the alias row normalized variant', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier_normalized'))
      return { rows: [{ id: 1698, variant_tier_normalized: 'slim' }] }
    return { rows: [] }
  })

  await mergeDuplicateProducts(db, { PS4: 'PlayStation  4' })

  const lookup = calls.find((c) => c.sql === FIND_SQL)
  expect(lookup?.params).toEqual(['playstation 4', 'slim'])
})

test('mergeDuplicateProducts merges into the existing canonical row instead of renaming when one already exists with the same variant', async () => {
  const { db, calls } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier_normalized'))
      return { rows: [{ id: 1698, variant_tier_normalized: null }] }
    if (sql === FIND_SQL) return { rows: [{ id: 532 }] } // collision: PlayStation 4 / null already exists as id 532
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 0, merged: 1 })
  const listingsReassign = calls.find((c) => c.sql.includes('UPDATE listings SET product_id'))
  expect(listingsReassign?.params).toEqual([532, 1698])
  const deleteLoser = calls.find((c) => c.sql === 'DELETE FROM products WHERE id = $1')
  expect(deleteLoser?.params).toEqual([1698])
})

test('mergeDuplicateProducts does not merge an alias row into itself when it already has the canonical normalized name', async () => {
  const { db } = scriptedDb((sql) => {
    if (sql.startsWith('SELECT id, variant_tier_normalized'))
      return { rows: [{ id: 1698, variant_tier_normalized: null }] }
    if (sql === FIND_SQL) return { rows: [{ id: 1698 }] }
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { 'playstation 4': 'PlayStation 4' })

  expect(result).toEqual({ renamed: 1, merged: 0 })
})

test('mergeDuplicateProducts processes multiple alias rows for the same canonical independently', async () => {
  const { db } = scriptedDb((sql, params) => {
    if (sql.startsWith('SELECT id, variant_tier_normalized')) {
      return {
        rows: [
          { id: 1505, variant_tier_normalized: 'slim' },
          { id: 1698, variant_tier_normalized: null },
          { id: 433, variant_tier_normalized: 'pro' },
        ],
      }
    }
    if (sql === FIND_SQL) {
      const variant = params[1]
      if (variant === 'slim') return { rows: [{ id: 499 }] } // collides with PlayStation 4 / Slim
      if (variant === null) return { rows: [{ id: 532 }] } // collides with PlayStation 4 / null
      return { rows: [] } // Pro: no collision, safe rename
    }
    return { rows: [] }
  })

  const result = await mergeDuplicateProducts(db, { PS4: 'PlayStation 4' })

  expect(result).toEqual({ renamed: 1, merged: 2 })
})
