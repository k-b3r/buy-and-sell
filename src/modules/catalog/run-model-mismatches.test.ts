import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { ProductMatchedListing } from './product-storage'
import { detectModelMismatches, reassignModelMismatches } from './run-model-mismatches'

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

  it('silently skips several mismatched prefixes and ignores consistent listings', async () => {
    const { db } = scriptedDb([
      listing({ title: 'Galaxy S23 A54', base_model: 'Galaxy S26 A15', variant_tier: null }),
      listing({ title: 'Samsung S26 Ultra' }),
    ])
    const lines: string[] = []

    const result = await reassignModelMismatches(db, (line) => lines.push(line), false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
    expect(lines).toEqual([])
  })

  it('skips a listing whose derived target is the product it already has', async () => {
    const { db } = scriptedDb([listing({ listing_id: '7' })], { 'samsung galaxy s23': [26] })

    const result = await reassignModelMismatches(db, () => {}, false)

    expect(result).toEqual({ reassigned: 0, skipped: 1 })
  })
})
