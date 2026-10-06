import type { DbClient } from '../../platform/storage'
import {
  flagNegotiableFromKeywords,
  getPriceReviewCandidates,
  upsertListingPriceReview,
  upsertKeywordNegotiable,
} from './listing-price-review'

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

  await upsertListingPriceReview(db, {
    listingId: '1000000000000001',
    data: {
      isNegotiable: true,
      priceLow: 7500,
      priceHigh: 9000,
      reasoning: 'Swap-only listing, real price is negotiable per description.',
    },
    model: 'openai/gpt-oss-120b',
    reviewedDescription: 'FOR SWAP SA RTX 3060, ADD AKO.',
  })

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

  await upsertListingPriceReview(db, {
    listingId: '123',
    data: {
      isNegotiable: false,
      priceLow: null,
      priceHigh: null,
      reasoning: 'No price mentioned anywhere in the text.',
    },
    model: 'openai/gpt-oss-120b',
    reviewedDescription: null,
  })

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

test('flagNegotiableFromKeywords upserts a keyword match from the title or description and returns the keyword', async () => {
  const { db, calls } = mockDb()

  expect(await flagNegotiableFromKeywords(db, '1', 'RTX 3060', 'Nego pa presyo')).toBe('nego')
  expect(await flagNegotiableFromKeywords(db, '2', 'PS5 Slim, price OBO', null)).toBe('obo')

  expect(calls.map((c) => c.params)).toEqual([
    ['1', 'keyword match: "nego"'],
    ['2', 'keyword match: "obo"'],
  ])
})

test('flagNegotiableFromKeywords returns null and makes no db call when nothing matches', async () => {
  const { db, calls } = mockDb()

  expect(await flagNegotiableFromKeywords(db, '1', 'Sony WH-1000XM6, barely used', 'clean unit no issues')).toBeNull()

  expect(calls).toHaveLength(0)
})

test('getPriceReviewCandidates takes no median over a price-lookup-excluded product, but still checks its listings for placeholder and description prices', async () => {
  const { db, calls } = mockDbWithRows([])

  await getPriceReviewCandidates(db)

  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[0].sql).toContain('LEFT JOIN product_medians m')
})
