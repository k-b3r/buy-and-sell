import { describe, expect, it } from 'vitest'
import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { ProductMatchedListing } from './store/products'
import {
  deriveTargetBaseModel,
  detectModelMismatches,
  findListingModelMismatches,
  findModelCodeMismatches,
  matchedProductText,
  planMismatchReassignment,
  reassignModelMismatches,
} from './model-mismatch'

function listing(overrides: Partial<ProductMatchedListing>): ProductMatchedListing {
  return {
    listing_id: '1',
    title: 'Samsung S23 Ultra',
    product_id: 26,
    base_model: 'Samsung Galaxy S26',
    variant_tier: 'Ultra',
    variant_tier_normalized: 'ultra',
    ...overrides,
  }
}

// Answers the matched-listings scan with `rows` and every product lookup
// from `products` (normalized base model -> ids).
function scriptedDb(
  rows: ProductMatchedListing[],
  products: Record<string, number[]> = {},
): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.includes('FROM listings l')) return { rows }
        if (sql.startsWith('SELECT id FROM products')) {
          return { rows: (products[params[0] as string] ?? []).map((id) => ({ id })) }
        }
        return { rows: [] }
      },
    },
  }
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  const push = (msg: string) => lines.push(msg)
  return { lines, logger: { info: push, warn: push, error: push } }
}

describe('detectModelMismatches', () => {
  it('logs each mismatched listing with its codes, then a summary over all scanned listings', async () => {
    const { db, calls } = scriptedDb([
      listing({ listing_id: '7' }),
      listing({ listing_id: '8', title: 'Samsung S26 Ultra' }),
    ])
    const { logger, lines } = recordingLogger()

    await detectModelMismatches(db, logger)

    expect(lines).toEqual([
      'listing 7 "Samsung S23 Ultra" -> product 26 "Samsung Galaxy S26 Ultra" | s: title=23 product=26',
      '1 candidate(s) found out of 2 product-matched listings',
    ])
    expect(calls.every((c) => !c.sql.startsWith('UPDATE'))).toBe(true)
  })
})

describe('reassignModelMismatches', () => {
  it('reassigns a listing to the existing product named after its title generation, keeping the variant', async () => {
    const { db, calls } = scriptedDb([listing({ listing_id: '7' })], { 'samsung galaxy s23': [23] })
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 1, skipped: 0 })
    const lookup = calls.find((c) => c.sql.startsWith('SELECT id FROM products'))
    expect(lookup?.params).toEqual(['samsung galaxy s23', 'ultra'])
    const update = calls.find((c) => c.sql.includes('UPDATE listings SET product_id'))
    expect(update?.params).toEqual(['7', 23])
    expect(lines).toEqual([
      'reassigning listing 7 "Samsung S23 Ultra": product 26 "Samsung Galaxy S26" -> product 23 "Samsung Galaxy S23"',
    ])
  })

  it('writes nothing on a dry run but still counts and reports what it would do', async () => {
    const { db, calls } = scriptedDb([listing({ listing_id: '7' })], { 'samsung galaxy s23': [23] })
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), true)

    expect(result).toEqual({ reassigned: 1, skipped: 0 })
    expect(calls.some((c) => c.sql.includes('UPDATE'))).toBe(false)
    expect(lines[0]).toMatch(/^\[dry run\] would reassign listing 7/)
  })

  it('skips with a reason when the derived target product does not exist, never creating it', async () => {
    const { db, calls } = scriptedDb([listing({ listing_id: '7' })])
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
    expect(lines).toEqual(['skip listing 7: derived target "Samsung Galaxy S23" has no existing matching product'])
    expect(calls.some((c) => c.sql.includes('INSERT') || c.sql.includes('UPDATE'))).toBe(false)
  })

  it('skips with a reason when the mismatch is ambiguous', async () => {
    const { db } = scriptedDb([listing({ listing_id: '7', title: 'S23 or S24', variant_tier: null })])
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
    expect(lines).toEqual(["skip listing 7: ambiguous mismatch, can't derive a single target base_model"])
  })

  it('skips with a reason when several model prefixes mismatch and ignores consistent listings', async () => {
    const { db } = scriptedDb([
      listing({ listing_id: '7', title: 'Galaxy S23 A54', base_model: 'Galaxy S26 A15', variant_tier: null }),
      listing({ title: 'Samsung S26 Ultra' }),
    ])
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
    expect(lines).toEqual(["skip listing 7: several model prefixes mismatch, can't pick a single target base_model"])
  })

  it('skips with a reason a listing whose derived target is the product it already has', async () => {
    const { db } = scriptedDb([listing({ listing_id: '7' })], { 'samsung galaxy s23': [26] })
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
    expect(lines).toEqual(['skip listing 7: derived target "Samsung Galaxy S23" is already its product 26'])
  })
})

describe('findModelCodeMismatches', () => {
  it('flags the real S23-vs-S26 mismatch found manually in listing 1000000000000002', () => {
    const result = findModelCodeMismatches('Samsung S23 ULTRA Dual Sim 256gb', 'Samsung Galaxy S26 Ultra')
    expect(result).toEqual([{ prefix: 's', titleNumbers: ['23'], productNumbers: ['26'] }])
  })

  it('does not flag when the generation number matches', () => {
    expect(findModelCodeMismatches('iPhone 13 Pro Max 128GB', 'iPhone 13 Pro Max')).toEqual([])
  })

  it('does not flag when title and product share no model-line prefix', () => {
    expect(findModelCodeMismatches('Room for rent near SM', 'Studio Unit Condo')).toEqual([])
  })

  it('ignores digit-before-letter specs like storage, network gen, and resolution', () => {
    expect(findModelCodeMismatches('Samsung A54 5G 128GB 4K display', 'Samsung Galaxy A54')).toEqual([])
  })

  it('flags a tight-form mismatch (A54 vs A14)', () => {
    expect(findModelCodeMismatches('Samsung A54 5G', 'Samsung Galaxy A14')).toEqual([
      { prefix: 'a', titleNumbers: ['54'], productNumbers: ['14'] },
    ])
  })

  it('flags a loose-form mismatch (Note 20 vs Note 10)', () => {
    expect(findModelCodeMismatches('Samsung Galaxy Note 20 Ultra', 'Samsung Galaxy Note 10')).toEqual([
      { prefix: 'note', titleNumbers: ['20'], productNumbers: ['10'] },
    ])
  })
})

describe('deriveTargetBaseModel', () => {
  it('swaps in the title generation number, keeping the product wording (S23-vs-S26 case)', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23'], productNumbers: ['26'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBe('Samsung Galaxy S23 Ultra')
  })

  it('handles the plain iPhone 14-vs-13 case', () => {
    const mismatch = { prefix: 'iphone', titleNumbers: ['14'], productNumbers: ['13'] }
    expect(deriveTargetBaseModel('iPhone 13', mismatch)).toBe('iPhone 14')
  })

  it('returns null when either side has more than one number for the prefix', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23', '24'], productNumbers: ['26'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBeNull()
  })

  it('returns null when the product number is not found in the base model text', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23'], productNumbers: ['99'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBeNull()
  })
})

describe('findListingModelMismatches', () => {
  it('compares the title against the product base model plus its variant tier', () => {
    const listing = { title: 'Samsung S23 Ultra 256gb', base_model: 'Samsung Galaxy S26', variant_tier: 'Ultra' }
    expect(matchedProductText(listing)).toBe('Samsung Galaxy S26 Ultra')
    expect(findListingModelMismatches(listing)).toEqual([{ prefix: 's', titleNumbers: ['23'], productNumbers: ['26'] }])
  })

  it('uses the base model alone when the product has no variant tier', () => {
    expect(matchedProductText({ title: 'x', base_model: 'iPhone 13', variant_tier: null })).toBe('iPhone 13')
  })
})

describe('planMismatchReassignment', () => {
  it('leaves a listing whose title agrees with its product alone', () => {
    expect(planMismatchReassignment({ title: 'iPhone 13 Pro', base_model: 'iPhone 13', variant_tier: 'Pro' })).toEqual({
      kind: 'consistent',
    })
  })

  it('targets the product name with the title generation swapped in', () => {
    expect(
      planMismatchReassignment({ title: 'Samsung S23 Ultra', base_model: 'Samsung Galaxy S26', variant_tier: 'Ultra' }),
    ).toEqual({ kind: 'target', targetBaseModel: 'Samsung Galaxy S23' })
  })

  it('refuses to pick when more than one prefix mismatches', () => {
    expect(
      planMismatchReassignment({ title: 'Galaxy S23 A54', base_model: 'Galaxy S26 A15', variant_tier: null }),
    ).toEqual({
      kind: 'multiple',
    })
  })

  it('reports ambiguous when the single mismatch has several numbers on one side', () => {
    expect(planMismatchReassignment({ title: 'S23 or S24', base_model: 'Galaxy S26', variant_tier: null })).toEqual({
      kind: 'ambiguous',
    })
  })
})
