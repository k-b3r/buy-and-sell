import { expect, test } from 'vitest'
import { queryDeals } from './deals'
import type { DealsQuery } from './deals'
import { notMagnitudeOutlierSql, peerListingSql } from './fragments'
import { repostKeySql } from '../domain/repost'
import type { QueryClient } from '../../../platform/storage'

const dealsQuery = (overrides: Partial<DealsQuery> = {}): DealsQuery => ({
  minProfitPesos: 1000,
  minPricePesos: 500,
  offset: 0,
  limit: 30,
  ...overrides,
})

test('queryDeals maps a raw row into a DealListing, resolving photo urls and casting numeric columns', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        {
          listing_id: 'l1',
          title: 'iPhone 12',
          ask_price: '10000',
          listed_at: new Date('2026-08-01T00:00:00Z'),
          primary_photo_url: 'https://example.com/p.jpg',
          stored_photo_urls: null,
          product_id: 42,
          base_model: 'iPhone 12',
          variant_tier: '128GB',
          category: 'Mobile Phones',
          sub_category: 'Smartphones',
          is_saved: true,
          tier: 'sold_comps',
          comp_count: '4',
          reference_price: '15000',
          profit_pesos: '5000',
          discount_percent: '33',
          days_listed: '5.4',
          is_low_confidence: false,
        },
      ],
    }),
  }

  const [deal] = await queryDeals(db, dealsQuery())

  expect(deal).toEqual({
    listing_id: 'l1',
    title: 'iPhone 12',
    ask_price: 10000,
    photo_url: 'https://example.com/p.jpg',
    product_id: 42,
    base_model: 'iPhone 12',
    variant_tier: '128GB',
    category: 'Mobile Phones',
    sub_category: 'Smartphones',
    reference_price: 15000,
    tier: 'sold_comps',
    comp_count: 4,
    profit_pesos: 5000,
    discount_percent: 33,
    days_listed: 5,
    is_saved: true,
    is_low_confidence: false,
  })
})

test('queryDeals excludes sold/removed listings by default, applies the discount-policy price floor, and orders by profit descending', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain('sold_at IS NULL')
  expect(capturedSql).toContain('flagged_removed_at IS NULL')
  expect(capturedSql).toContain(peerListingSql('pl'))
  expect(capturedSql).toContain('ORDER BY')
  expect(capturedSql).toContain('DESC, profit_pesos DESC NULLS LAST')
  expect(capturedParams).toContain(1000) // minProfitPesos floor
  expect(capturedParams).toContain(500) // minPricePesos floor
})

test('queryDeals dedupes same-product listings sharing an identical title (repost heuristic), keeping the earliest', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  const key = repostKeySql('title', 'listing_id')
  expect(capturedSql).toContain(`DISTINCT ON (product_id, ${key})`)
  expect(capturedSql).toContain(`ORDER BY product_id, ${key}, listed_at ASC NULLS LAST, listing_id`)
})

test('queryDeals sorts by tier rank first, profit only breaks ties within a tier', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain(
    "ORDER BY CASE tier WHEN 'sold_comps' THEN 3 WHEN 'peer_listings' THEN 2 WHEN 'llm_estimate' THEN 1 ELSE 0 END DESC, profit_pesos DESC NULLS LAST, listing_id",
  )
})

test('queryDeals switches to sold listings when soldOnly is set', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ soldOnly: true }))

  expect(capturedSql).toContain('sold_at IS NOT NULL')
})

test('queryDeals excludes price_lookup_excluded products from the llm_estimate tier too, not just sold/peer comps', async () => {
  // Regression: confirmed live 2026-09-02 that two unrelated "House & Lot"
  // listings (price_lookup_excluded=true) shared the same nonsense
  // trained-price estimate and surfaced as ₱200M+ "deals" - the CTE feeding
  // llm_estimate wasn't gated on the flag the way sold_comp/peer_median are.
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  const pCteMatch = capturedSql.match(/p AS \(([\s\S]*?)\),\s*llm_estimate AS/)
  expect(pCteMatch).not.toBeNull()
  expect(pCteMatch![1]).toContain('NOT prod.price_lookup_excluded')
})

test('queryDeals filters by category and max days listed when provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ categories: ['Mobile Phones'], maxDaysListed: 14 }))

  expect(capturedSql).toContain('category = ANY(')
  expect(capturedSql).toContain('days_listed <=')
  expect(capturedParams).toContain(14)
  expect(capturedParams.some((p) => Array.isArray(p) && p.includes('Mobile Phones'))).toBe(true)
})

test('queryDeals filters to listings first seen within the given hours', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ addedWithinHours: 48 }))

  expect(capturedSql).toContain('first_seen_at >= now() - make_interval(hours =>')
  expect(capturedParams).toContain(48)
})

test('queryDeals filters by title or base_model when a search term is provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ search: '  iphone 16  ' }))

  expect(capturedSql).toContain('AND (title ILIKE')
  expect(capturedSql).toContain('OR base_model ILIKE')
  expect(capturedParams).toContain('%iphone 16%')
})

test('queryDeals omits the search clause when no search term is provided', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).not.toContain('title ILIKE')
})

test('queryDeals filters by minimum confidence tier rank', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ minConfidenceTier: 'peer_listings' }))

  expect(capturedSql).toContain(
    "CASE tier WHEN 'sold_comps' THEN 3 WHEN 'peer_listings' THEN 2 WHEN 'llm_estimate' THEN 1 ELSE 0 END >=",
  )
  expect(capturedParams).toContain(2)
})

test('queryDeals guards against a decoy ask price with the shared 10x outlier rule, dropping non-positive reference prices', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain(notMagnitudeOutlierSql('ask_price', 'reference_price'))
})

test('queryDeals uses the price review over the raw recorded price when one exists', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain('LEFT JOIN listing_price_review pr ON pr.listing_id = l.id')
  expect(capturedSql).toContain('COALESCE(pr.price_high, pr.price_low, l.price_amount) AS ask_price')
})

test('queryDeals selects comp_count from the same tier branch that won reference_price', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain('WHEN sc.clean_median_price IS NOT NULL THEN sc.sample_size')
  expect(capturedSql).toContain('WHEN pm.clean_median_price IS NOT NULL THEN pm.sample_size')
  expect(capturedSql).toContain('END AS comp_count')
})

test('queryDeals returns the low-confidence bucket instead of the main list when lowConfidenceOnly is set', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery({ lowConfidenceOnly: true }))

  expect(capturedSql).toContain("(tier IS NULL OR (tier = 'llm_estimate' AND COALESCE(peer_sample_size, 0) <= 1)) =")
  expect(capturedParams).toContain(true)
})

// Regression: confirmed live 2026-09-03 that phones (dedupe cleanly across
// sellers into one product, so they reach sold_comps/peer_listings far more
// often than one-off items (~75% of products are singleton-listing)
// and produce bigger absolute profit_pesos at their price point) crowded out
// every other category on the ranked list, since nothing capped how many of
// one category could appear.
test('queryDeals caps each category at 10 rows via a per-category ROW_NUMBER, applied only to the main list', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await queryDeals(db, dealsQuery())

  expect(capturedSql).toContain('ROW_NUMBER() OVER (')
  expect(capturedSql).toContain("PARTITION BY COALESCE(category, '')")
  expect(capturedSql).toContain('category_rank <=')
  expect(capturedParams).toContain(10)

  // lowConfidenceOnly bypasses the cap (the low-confidence bucket isn't
  // tier/profit-ranked the same way as the main list).
  await queryDeals(db, dealsQuery({ lowConfidenceOnly: true }))
  expect(capturedSql).toMatch(/WHERE \$\d+ OR category_rank <= \$\d+/)
})
