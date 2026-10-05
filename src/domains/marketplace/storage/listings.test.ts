import type { DbClient } from '../../../platform/storage'
import {
  getNegotiableKeywordCandidates,
  getPriceReviewCandidates,
  upsertListingPriceReview,
  upsertKeywordNegotiable,
  checkListingDiscount,
  getUnverifiedDiscountCandidates,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
  markDiscountNotificationAttempted,
} from './listings'

function mockDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return undefined
      },
    },
  }
}

test('getNegotiableKeywordCandidates returns listings not already flagged negotiable', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: '1', title: 'RTX 3060', description: 'nego pa' }] }
    },
  }

  const result = await getNegotiableKeywordCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('is_negotiable = true')
  expect(result).toEqual([{ id: '1', title: 'RTX 3060', description: 'nego pa' }])
})

test('getPriceReviewCandidates returns listings the SQL flagged as a magnitude outlier vs their product median', async () => {
  const { db, calls } = mockDbWithRows([
    {
      id: '1000000000000001',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      description: 'FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED.',
      price_amount: '999999999',
      price_outlier: true,
      placeholder_price: false,
    },
  ])

  const result = await getPriceReviewCandidates(db)

  expect(calls[0].sql).toContain('percentile_cont(0.5)')
  expect(calls[0].sql).toContain('median_price / 5')
  expect(calls[0].sql).toContain('median_price * 5')
  expect(calls[0].sql).toContain('listing_price_review')
  expect(result).toEqual([
    {
      id: '1000000000000001',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      description: 'FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED.',
      price_amount: 999999999,
    },
  ])
})

test('getPriceReviewCandidates re-flags a listing once its description differs from the reviewed one', async () => {
  const { db, calls } = mockDbWithRows([])

  await getPriceReviewCandidates(db)

  // LEFT JOIN + IS DISTINCT FROM, not NOT EXISTS - a reviewed listing whose
  // seller later edits the description comes back through.
  expect(calls[0].sql).toContain('LEFT JOIN listing_price_review r ON r.listing_id = l.id')
  expect(calls[0].sql).toContain('l.description IS DISTINCT FROM r.reviewed_description')
  expect(calls[0].sql).not.toContain('NOT EXISTS')
})

test('getPriceReviewCandidates keeps a description-price divergence the SQL flagged, drops a non-divergent one', async () => {
  const { db } = mockDbWithRows([
    // recorded ₱3,900 but description says "39k" - ~10x, kept
    {
      id: 'diverges',
      title: 'I phone 16 used',
      description: 'iphone 16 128gb\nprice 39k',
      price_amount: '3900',
      price_outlier: false,
      placeholder_price: false,
    },
    // description mentions "45k" and the recorded price is ₱44,000 - the loose
    // SQL branch matched, but there's no real divergence, so it's dropped
    {
      id: 'close-enough',
      title: 'iPhone 15',
      description: 'selling 45k slight nego',
      price_amount: '44000',
      price_outlier: false,
      placeholder_price: false,
    },
  ])

  const result = await getPriceReviewCandidates(db)

  expect(result.map((c) => c.id)).toEqual(['diverges'])
})

test('getPriceReviewCandidates also flags placeholder digit-pattern prices (123, 999, 12,567) regardless of magnitude', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getPriceReviewCandidates(db)

  // Same repeated-digit / ascending-run regex as the dashboard's
  // notPlaceholderPriceSql, applied both to exclude placeholders from the
  // median input and to flag a listing whose own price matches, independent
  // of the magnitude-outlier OR branch.
  expect(calls[0].sql).toContain("~ '^(\\d+)\\1+$'")
  expect(calls[0].sql).toContain("~ '012|123|234|345|456|567|678|789'")
  const occurrences = calls[0].sql.split('^(\\d+)\\1+$').length - 1
  expect(occurrences).toBe(2) // once excluding placeholders from the median, once flagging the listing itself
})

test('upsertListingPriceReview inserts is_negotiable, price range, reasoning, and model', async () => {
  const { db, calls } = mockDb()

  await upsertListingPriceReview(
    db,
    '1000000000000001',
    {
      isNegotiable: true,
      priceLow: 7500,
      priceHigh: 9000,
      reasoning: 'Swap-only listing, real price is negotiable per description.',
    },
    'openai/gpt-oss-120b',
    'FOR SWAP SA RTX 3060, ADD AKO.',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].sql).toContain('reviewed_description = EXCLUDED.reviewed_description')
  expect(calls[0].params).toEqual([
    '1000000000000001',
    true,
    7500,
    9000,
    'Swap-only listing, real price is negotiable per description.',
    'openai/gpt-oss-120b',
    'FOR SWAP SA RTX 3060, ADD AKO.',
  ])
})

test('upsertListingPriceReview stores null price range when no real price could be determined', async () => {
  const { db, calls } = mockDb()

  await upsertListingPriceReview(
    db,
    '123',
    { isNegotiable: false, priceLow: null, priceHigh: null, reasoning: 'No price mentioned anywhere in the text.' },
    'openai/gpt-oss-120b',
    null,
  )

  expect(calls[0].params).toEqual([
    '123',
    false,
    null,
    null,
    'No price mentioned anywhere in the text.',
    'openai/gpt-oss-120b',
    null,
  ])
})

test('upsertKeywordNegotiable inserts is_negotiable=true with no price estimate, tagged as a keyword-scan match', async () => {
  const { db, calls } = mockDb()

  await upsertKeywordNegotiable(db, '123', 'nego')

  expect(calls[0].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].sql).not.toContain('price_low = EXCLUDED')
  expect(calls[0].sql).not.toContain('reasoning = EXCLUDED')
  expect(calls[0].params).toEqual(['123', 'keyword match: "nego"'])
})

function mockDbWithRows(rows: unknown[]): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

test('checkListingDiscount does nothing when priceAmount is null or non-positive', async () => {
  const { db, calls } = mockDb()

  await checkListingDiscount(db, '1', 10, 'Used - Good', null, null, { low: 5000, high: 6000, currency: 'PHP' })
  await checkListingDiscount(db, '1', 10, 'Used - Good', 0, null, { low: 5000, high: 6000, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount uses retail for a "New" condition listing and inserts when it qualifies', async () => {
  const { db, calls } = mockDb()

  // ₱7,000 vs ₱10,000 retail low = 30% off, ₱3,000 profit - clears both bars.
  await checkListingDiscount(db, '1', 10, 'New', 7000, { low: 10000, high: 12000, currency: 'PHP' }, null)

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO discount_notifications')
  expect(calls[0].params).toEqual(['1', 10, 30, 10000])
})

test('checkListingDiscount treats "Used - like new" as used, not new - uses secondhand, not retail', async () => {
  const { db, calls } = mockDb()

  // Retail (10000) would show 30% off; secondhand (7500) shows only 20% off
  // (below the 30% bar) - if this used retail by mistake, it would wrongly qualify.
  await checkListingDiscount(
    db,
    '1',
    10,
    'Used - like new',
    7000,
    { low: 10000, high: 12000, currency: 'PHP' },
    { low: 8750, high: 9000, currency: 'PHP' },
  )

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount prefers secondhand over peer-comparison when secondhand is available', async () => {
  const { db, calls } = mockDb()

  // Secondhand low 10000 -> 30% off at price 7000. If this fell back to peer
  // median instead, no query would even run to produce a number - the
  // absence of a peer-median SELECT call here proves secondhand won.
  await checkListingDiscount(db, '1', 10, 'Used - Good', 7000, null, { low: 10000, high: 12000, currency: 'PHP' })

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO discount_notifications')
  expect(calls[0].params).toEqual(['1', 10, 30, 10000])
})

test('checkListingDiscount falls back to peer-comparison median when secondhand is not available', async () => {
  const { db, calls } = mockDbWithRows([{ clean_median_price: '10000' }])

  await checkListingDiscount(db, '1', 10, 'Used - Good', 7000, null, null)

  const selectCall = calls.find((c) => c.sql.includes('percentile_cont'))
  expect(selectCall).toBeDefined()
  expect(selectCall?.params).toEqual([10])
  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO discount_notifications'))
  expect(insertCall?.params).toEqual(['1', 10, 30, 10000])
})

test('checkListingDiscount does nothing when peer-comparison has no sibling median to compare against', async () => {
  const { db, calls } = mockDbWithRows([{ clean_median_price: null }])

  await checkListingDiscount(db, '1', 10, 'Used - Good', 7000, null, null)

  expect(calls.some((c) => c.sql.startsWith('INSERT INTO discount_notifications'))).toBe(false)
})

test('checkListingDiscount does nothing when the discount is below the 30% bar', async () => {
  const { db, calls } = mockDb()

  // ₱9,000 vs ₱10,000 = only 10% off.
  await checkListingDiscount(db, '1', 10, 'Used - Good', 9000, null, { low: 10000, high: 12000, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount does nothing when the profit is below the ₱1,000 bar even if the percent clears', async () => {
  const { db, calls } = mockDb()

  // ₱140 vs ₱200 = 30% off, but only ₱60 profit.
  await checkListingDiscount(db, '1', 10, 'Used - Good', 140, null, { low: 200, high: 250, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount does nothing when the listing price is below the ₱500 floor even if percent and profit both clear', async () => {
  const { db, calls } = mockDb()

  // ₱300 vs ₱1,400 = 79% off, ₱1,100 profit - both bars clear, but ₱300 is
  // too cheap to be worth chasing (also the regime where generic-category
  // mismatches like "Bikini"/"Apple Pencil" produce noisy reference prices).
  await checkListingDiscount(db, '1', 10, 'Used - Good', 300, null, { low: 1400, high: 1600, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount inserts a ₱500 item reselling for ₱1,500 - a real ₱1,000-profit flip, not excluded just for being cheap', async () => {
  const { db, calls } = mockDb()

  await checkListingDiscount(db, '1', 10, 'Used - Good', 500, null, { low: 1500, high: 1700, currency: 'PHP' })

  expect(calls).toHaveLength(1)
})

test('checkListingDiscount does nothing when the listing price is a magnitude outlier vs the reference', async () => {
  const { db, calls } = mockDb()

  // ₱10 vs ₱10,000 reference - looks like a 99.9% discount, but it's an
  // obvious placeholder/typo, not a real deal.
  await checkListingDiscount(db, '1', 10, 'Used - Good', 10, null, { low: 10000, high: 12000, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('checkListingDiscount does nothing when the listing price is a placeholder digit-pattern, even though it clears the magnitude-outlier band', async () => {
  const { db, calls } = mockDb()

  // ₱12,345 vs ₱20,400 reference - 39% off, well inside the 10x magnitude
  // band, so it isn't caught there. But 12345 is a classic "for attention
  // only" placeholder price, not a real ask (live case: listing
  // 100000000000003, iPhone 14 "For Sale" at ₱12,345).
  await checkListingDiscount(db, '1', 10, 'Used - Good', 12345, null, { low: 20400, high: 22000, currency: 'PHP' })

  expect(calls).toHaveLength(0)
})

test('getUnverifiedDiscountCandidates returns pending candidates with listing/product/enrichment context, respecting the retry backoff', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 7,
            listing_id: '123',
            title: 'Sony WH-1000XM5',
            description: 'Used, minor scuff, battery great',
            condition: 'Used - Good',
            price_amount: '6500',
            base_model: 'Sony WH-1000XM5',
            is_specific_product: true,
          },
        ],
      }
    },
  }

  const result = await getUnverifiedDiscountCandidates(db, 3)

  expect(calls[0].sql).toContain('verified_at IS NULL')
  expect(calls[0].sql).toContain('last_verification_attempt_at IS NULL')
  expect(calls[0].sql).toContain("interval '1 hour'")
  expect(calls[0].sql).toContain('LIMIT $1')
  // Excludes a still-unenriched candidate unless its price already fails the
  // floor (that gate needs no enrichment data - see minPricePesos's own
  // comment) - never even fetched until enrich-products actually judges it.
  expect(calls[0].sql).toContain('pe.is_specific_product IS NOT NULL OR l.price_amount < $2')
  expect(calls[0].params).toEqual([3, 500])
  expect(result).toEqual([
    {
      id: 7,
      listing_id: '123',
      title: 'Sony WH-1000XM5',
      description: 'Used, minor scuff, battery great',
      condition: 'Used - Good',
      price_amount: 6500,
      base_model: 'Sony WH-1000XM5',
      is_specific_product: true,
    },
  ])
})

test('markDiscountNotificationVerified sets verified_at and overwrites discount_percent/reference_price with the fresh numbers', async () => {
  const { db, calls } = mockDb()

  await markDiscountNotificationVerified(db, 7, {
    discountPercent: 32,
    referencePrice: 10000,
    source: 'tavily',
    reasoning: 'Fresh secondhand market ~₱10k; minor wear does not explain the gap.',
  })

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('verified_at = now()')
  expect(calls[0].sql).toContain('WHERE id = $1')
  expect(calls[0].params).toEqual([
    7,
    32,
    10000,
    'tavily',
    'Fresh secondhand market ~₱10k; minor wear does not explain the gap.',
  ])
})

test('rejectDiscountNotification deletes the row outright', async () => {
  const { db, calls } = mockDb()

  await rejectDiscountNotification(db, 7)

  expect(calls[0].sql).toMatch(/^DELETE FROM discount_notifications/)
  expect(calls[0].params).toEqual([7])
})

test('markDiscountNotificationAttempted bumps last_verification_attempt_at without touching verified_at', async () => {
  const { db, calls } = mockDb()

  await markDiscountNotificationAttempted(db, 7)

  expect(calls[0].sql).toMatch(/^UPDATE discount_notifications/)
  expect(calls[0].sql).toContain('last_verification_attempt_at = now()')
  expect(calls[0].sql).not.toContain('verified_at = now()')
  expect(calls[0].params).toEqual([7])
})
