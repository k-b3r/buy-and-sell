import type { DbClient } from '../../../platform/storage'
import { peerListingSql } from '../store/fragments'
import { decideListingDiscount } from './discount-notifications'

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

const used = (priceAmount: number | null) => ({ id: '1', productId: 10, condition: 'Used - Good', priceAmount })
const range = (low: number, high: number) => ({ low, high, currency: 'PHP' })

test('decideListingDiscount returns null when priceAmount is null or non-positive', async () => {
  const { db, calls } = mockDb()
  const pricing = { retail: null, secondhand: range(5000, 6000) }

  expect(await decideListingDiscount(db, used(null), pricing)).toBeNull()
  expect(await decideListingDiscount(db, used(0), pricing)).toBeNull()
  expect(calls).toHaveLength(0)
})

test('decideListingDiscount uses retail for a "New" condition listing and returns the notification when it qualifies, without writing', async () => {
  const { db, calls } = mockDb()

  // ₱7,000 vs ₱10,000 retail low = 30% off, ₱3,000 profit - clears both bars.
  const decided = await decideListingDiscount(
    db,
    { id: '1', productId: 10, condition: 'New', priceAmount: 7000 },
    { retail: range(10000, 12000), secondhand: null },
  )

  expect(decided).toEqual({ listingId: '1', productId: 10, discountPercent: 30, referencePrice: 10000 })
  expect(calls).toHaveLength(0)
})

test('decideListingDiscount treats "Used - like new" as used, not new - uses secondhand, not retail', async () => {
  const { db } = mockDb()

  // Retail (10000) would show 30% off; secondhand (8750) shows only 20% off
  // (below the 30% bar) - if this used retail by mistake, it would wrongly qualify.
  const decided = await decideListingDiscount(
    db,
    { id: '1', productId: 10, condition: 'Used - like new', priceAmount: 7000 },
    { retail: range(10000, 12000), secondhand: range(8750, 9000) },
  )

  expect(decided).toBeNull()
})

test('decideListingDiscount prefers secondhand over peer-comparison when secondhand is available', async () => {
  const { db, calls } = mockDb()

  // Secondhand low 10000 -> 30% off at price 7000. No peer-median SELECT
  // call proves secondhand won.
  const decided = await decideListingDiscount(db, used(7000), { retail: null, secondhand: range(10000, 12000) })

  expect(decided).toEqual({ listingId: '1', productId: 10, discountPercent: 30, referencePrice: 10000 })
  expect(calls).toHaveLength(0)
})

test('decideListingDiscount falls back to peer-comparison median when secondhand is not available', async () => {
  const { db, calls } = mockDbWithRows([{ sample_size: '4', clean_median_price: '10000' }])

  const decided = await decideListingDiscount(db, used(7000), { retail: null, secondhand: null })

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('percentile_cont')
  expect(calls[0].sql).toContain(peerListingSql('pl'))
  expect(calls[0].params).toEqual([10])
  expect(decided).toEqual({ listingId: '1', productId: 10, discountPercent: 30, referencePrice: 10000 })
})

test('decideListingDiscount returns null when peer-comparison has no sibling median to compare against', async () => {
  const { db } = mockDbWithRows([{ sample_size: '1', clean_median_price: null }])

  expect(await decideListingDiscount(db, used(7000), { retail: null, secondhand: null })).toBeNull()
})

test('decideListingDiscount returns null when the discount is below the 30% bar', async () => {
  const { db } = mockDb()

  // ₱9,000 vs ₱10,000 = only 10% off.
  expect(await decideListingDiscount(db, used(9000), { retail: null, secondhand: range(10000, 12000) })).toBeNull()
})

test('decideListingDiscount returns null when the profit is below the ₱1,000 bar even if the percent clears', async () => {
  const { db } = mockDb()

  // ₱140 vs ₱200 = 30% off, but only ₱60 profit.
  expect(await decideListingDiscount(db, used(140), { retail: null, secondhand: range(200, 250) })).toBeNull()
})

test('decideListingDiscount returns null when the listing price is below the ₱500 floor even if percent and profit both clear', async () => {
  const { db } = mockDb()

  // ₱300 vs ₱1,400 = 79% off, ₱1,100 profit - both bars clear, but ₱300 is
  // too cheap to be worth chasing (also the regime where generic-category
  // mismatches like "Bikini"/"Apple Pencil" produce noisy reference prices).
  expect(await decideListingDiscount(db, used(300), { retail: null, secondhand: range(1400, 1600) })).toBeNull()
})

test('decideListingDiscount qualifies a ₱500 item reselling for ₱1,500 - a real ₱1,000-profit flip, not excluded just for being cheap', async () => {
  const { db } = mockDb()

  expect(await decideListingDiscount(db, used(500), { retail: null, secondhand: range(1500, 1700) })).toEqual({
    listingId: '1',
    productId: 10,
    discountPercent: 67,
    referencePrice: 1500,
  })
})

test('decideListingDiscount returns null when the listing price is a magnitude outlier vs the reference', async () => {
  const { db } = mockDb()

  // ₱10 vs ₱10,000 reference - looks like a 99.9% discount, but it's an
  // obvious placeholder/typo, not a real deal.
  expect(await decideListingDiscount(db, used(10), { retail: null, secondhand: range(10000, 12000) })).toBeNull()
})

test('decideListingDiscount returns null when the listing price is a placeholder digit-pattern, even though it clears the magnitude-outlier band', async () => {
  const { db } = mockDb()

  // ₱12,345 vs ₱20,400 reference - 39% off, well inside the 10x magnitude
  // band, so it isn't caught there. But 12345 is a classic "for attention
  // only" placeholder price, not a real ask (live case: listing
  // 100000000000003, iPhone 14 "For Sale" at ₱12,345).
  expect(await decideListingDiscount(db, used(12345), { retail: null, secondhand: range(20400, 22000) })).toBeNull()
})
