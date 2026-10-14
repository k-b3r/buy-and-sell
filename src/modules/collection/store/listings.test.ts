import type { DbClient } from '../../../platform/storage'
import {
  getCollectedListingIds,
  getCheckListingsCandidates,
  getDealCheckCandidates,
  getListingCheckCandidate,
  getListingCheckCandidatesForProduct,
  markListingAlive,
  markListingSold,
  flagListingRemoved,
  deleteListing,
  getBackfillCandidates,
  markListingPhotosUnavailable,
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

test('getCollectedListingIds returns every listing id as a Set, for dedup during collection', async () => {
  const db = {
    query: async (sql: string) => {
      expect(sql).toBe('SELECT id FROM listings')
      return { rows: [{ id: '1' }, { id: '2' }] }
    },
  }

  const result = await getCollectedListingIds(db)

  expect(result).toBeInstanceOf(Set)
  expect([...result]).toEqual(['1', '2'])
})

test('getCheckListingsCandidates orders by last_checked_at then listed_at, oldest/never-checked first', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50)

  expect(calls[0].sql).toContain('ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST')
  expect(calls[0].sql).toContain('LIMIT $1')
  expect(calls[0].sql).toContain('WHERE sold_at IS NULL')
  expect(calls[0].params).toEqual([50])
})

test('getListingCheckCandidatesForProduct scopes to one product, excludes sold, orders oldest/never-checked first', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getListingCheckCandidatesForProduct(db, 42)

  expect(calls[0].sql).toContain('WHERE product_id = $1')
  expect(calls[0].sql).toContain('AND sold_at IS NULL')
  expect(calls[0].sql).toContain('ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST')
  expect(calls[0].params).toEqual([42])
})

test('markListingAlive sets last_checked_at and clears any removal flag and sold flag', async () => {
  const { db, calls } = mockDb()

  await markListingAlive(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].sql).toContain('flagged_removed_at = NULL')
  expect(calls[0].sql).toContain('sold_at = NULL')
  expect(calls[0].params).toEqual(['123'])
})

test('markListingSold sets sold_at and last_checked_at', async () => {
  const { db, calls } = mockDb()

  await markListingSold(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('sold_at = now()')
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].params).toEqual(['123'])
})

test('flagListingRemoved sets both flagged_removed_at and last_checked_at, does not delete', async () => {
  const { db, calls } = mockDb()

  await flagListingRemoved(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('flagged_removed_at = now()')
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].params).toEqual(['123'])
})

test('deleteListing removes the row by id', async () => {
  const { db, calls } = mockDb()

  await deleteListing(db, '123')

  expect(calls[0].sql).toMatch(/^DELETE FROM listings/)
  expect(calls[0].params).toEqual(['123'])
})

test('getBackfillCandidates returns listings without stored photos, with their raw_json', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const rawListing = { id: '1', marketplace_listing_title: 'Mic' }
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: '1', raw_json: rawListing }] }
    },
  }

  const result = await getBackfillCandidates(db)

  expect(calls[0].sql).toContain('WHERE stored_photo_urls IS NULL')
  expect(result).toEqual([{ id: '1', raw_json: rawListing }])
})

test('markListingPhotosUnavailable sets stored_photo_urls to an empty array', async () => {
  const { db, calls } = mockDb()

  await markListingPhotosUnavailable(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('stored_photo_urls')
  expect(calls[0].params).toEqual(['123'])
})

test('getCheckListingsCandidates keeps the original query when reRecheckMinDays is 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 0)

  expect(calls[0].sql).not.toContain('Real Estate')
  expect(calls[0].params).toEqual([50])
})

test('getCheckListingsCandidates skips recently checked real estate listings only when reRecheckMinDays > 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 7)

  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('l.sold_at IS NULL')
  expect(calls[0].sql).toContain('ORDER BY l.last_checked_at ASC NULLS FIRST, l.listed_at ASC NULLS LAST')
  expect(calls[0].params).toEqual([50, 7])
})

test('getDealCheckCandidates picks unsold listings among the given ids not checked within minHours, stalest first', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: 'a', flagged_removed_at: null, source_photo_ids: null }] }
    },
  }

  const rows = await getDealCheckCandidates(db, ['a', 'b'], 6)

  expect(rows).toEqual([{ id: 'a', flagged_removed_at: null, source_photo_ids: null }])
  expect(calls[0].sql).toContain('id = ANY($1)')
  expect(calls[0].sql).toContain('sold_at IS NULL')
  expect(calls[0].sql).toContain('last_checked_at IS NULL OR last_checked_at < now() - make_interval(hours => $2)')
  expect(calls[0].sql).toContain('ORDER BY last_checked_at ASC NULLS FIRST')
  expect(calls[0].params).toEqual([['a', 'b'], 6])
})

test('getDealCheckCandidates skips the query when there are no ids', async () => {
  const db = {
    query: async () => {
      throw new Error('should not query')
    },
  }

  expect(await getDealCheckCandidates(db, [], 6)).toEqual([])
})

test('getListingCheckCandidate selects one listing by id without filtering on sold_at, or null when missing', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const candidate = { id: '123', flagged_removed_at: null, source_photo_ids: ['p1'] }
  const db = (rows: unknown[]): DbClient => ({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows }
    },
  })

  expect(await getListingCheckCandidate(db([candidate]), '123')).toEqual(candidate)
  expect(await getListingCheckCandidate(db([]), 'missing')).toBeNull()
  expect(calls[0].sql).toContain('WHERE id = $1')
  expect(calls[0].sql).not.toContain('sold_at')
  expect(calls[0].params).toEqual(['123'])
})
