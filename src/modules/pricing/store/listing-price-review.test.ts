import type { DbClient } from '../../../platform/storage'
import { getPriceReviewRows, upsertKeywordNegotiable, upsertListingPriceReview } from './listing-price-review'

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

test('getPriceReviewRows flags listings off their product median by 5x, with a placeholder price, or naming a price, skipping reviewed ones whose description is unchanged', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: DbClient = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          { id: '1', title: 't', description: null, price_amount: '3900', review_flag: true, placeholder_price: false },
          {
            id: '2',
            title: 'u',
            description: 'price 39k',
            price_amount: '39000',
            review_flag: false,
            placeholder_price: false,
          },
        ],
      }
    },
  }

  const rows = await getPriceReviewRows(db)

  expect(calls[0].sql).toContain('raw_median_price / 5')
  expect(calls[0].sql).toContain('raw_median_price * 5')
  expect(calls[0].sql).toContain('WHERE review_flag OR placeholder_price OR description_mentions_price')
  expect(calls[0].sql).toContain('l.description IS DISTINCT FROM r.reviewed_description')
  expect(calls[0].params).toEqual([])
  expect(rows).toEqual([
    { id: '1', title: 't', description: null, price_amount: 3900, priceSuspicious: true },
    { id: '2', title: 'u', description: 'price 39k', price_amount: 39000, priceSuspicious: false },
  ])
})
