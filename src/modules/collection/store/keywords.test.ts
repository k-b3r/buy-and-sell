import { expect, test } from 'vitest'
import {
  getCollectKeywords,
  getEnabledGeneralKeywords,
  loadRealEstateKeywords,
  replaceCollectKeywords,
} from './keywords'
import type { QueryClient } from '../../../platform/storage'

test('getCollectKeywords maps rows into keyword + enabled entries', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        { keyword: 'moving out', enabled: true },
        { keyword: 'rush sale', enabled: false },
      ],
    }),
  }

  expect(await getCollectKeywords(db)).toEqual([
    { keyword: 'moving out', enabled: true },
    { keyword: 'rush sale', enabled: false },
  ])
})

test('replaceCollectKeywords deletes all rows then inserts the new list in one batch', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [
    { keyword: 'rush sale', enabled: true },
    { keyword: 'garage sale', enabled: false },
  ])

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
  expect(calls[1].sql).toContain('INSERT INTO collect_keywords')
  expect(calls[1].sql).toContain('enabled')
  expect(calls[1].params).toEqual(['rush sale', true, 'garage sale', false])
})

test('replaceCollectKeywords still deletes when the new list is empty, skips the insert', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
})

test('getCollectKeywords and replaceCollectKeywords only touch general keywords', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCollectKeywords(db)
  await replaceCollectKeywords(db, [{ keyword: 'rush sale', enabled: true }])

  expect(calls[0].sql).toContain("kind = 'general'")
  expect(calls[1].sql).toContain("DELETE FROM collect_keywords WHERE kind = 'general'")
})

test('getEnabledGeneralKeywords selects only enabled general keywords, ordered by keyword', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ keyword: 'preloved' }, { keyword: 'rush sale' }] }
    },
  }

  expect(await getEnabledGeneralKeywords(db)).toEqual(['preloved', 'rush sale'])
  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('FROM collect_keywords')
  expect(calls[0].sql).toContain('WHERE enabled')
  expect(calls[0].sql).toContain("kind = 'general'")
  expect(calls[0].sql).toContain('ORDER BY keyword')
})

test('loadRealEstateKeywords selects only enabled real_estate keywords, ordered by keyword', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ keyword: 'house and lot' }] }
    },
  }

  expect(await loadRealEstateKeywords(db)).toEqual(['house and lot'])
  expect(calls[0].sql).toContain('WHERE enabled')
  expect(calls[0].sql).toContain("kind = 'real_estate'")
  expect(calls[0].sql).toContain('ORDER BY keyword')
})
