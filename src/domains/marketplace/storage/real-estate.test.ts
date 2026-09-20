import type { DbClient } from '../../../platform/storage'
import { getRealEstateCandidates, upsertRealEstateDetails } from './real-estate'
import type { RealEstateFields } from '../real-estate'

function recordingDb(rows: unknown[] = []): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
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

test('getRealEstateCandidates selects unextracted or changed real estate listings, excluding removed ones', async () => {
  const { db, calls } = recordingDb([
    { id: '1', title: 'Condo', description: 'd', price_amount: '4500000', source_hash: 'abc' },
    { id: '2', title: 'Lot', description: null, price_amount: null, source_hash: 'def' },
  ])

  const result = await getRealEstateCandidates(db, 50)

  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('flagged_removed_at IS NULL')
  expect(calls[0].sql).toContain('d.listing_id IS NULL')
  expect(calls[0].sql).toContain('d.source_hash IS DISTINCT FROM')
  expect(calls[0].params).toEqual([50])
  expect(result).toEqual([
    { id: '1', title: 'Condo', description: 'd', price_amount: 4500000, source_hash: 'abc' },
    { id: '2', title: 'Lot', description: null, price_amount: null, source_hash: 'def' },
  ])
})

test('upsertRealEstateDetails writes every field in a stable parameter order and re-stamps extracted_at', async () => {
  const { db, calls } = recordingDb()
  const fields: RealEstateFields = {
    listing_type: 'sale',
    property_type: 'condo',
    price_php: 4500000,
    price_basis: 'total',
    lot_sqm: null,
    floor_sqm: 35,
    bedrooms: 1,
    bathrooms: 1,
    project_name: 'Sheridan Tower',
    area_text: 'Mandaluyong',
    tags: ['rfo'],
    confidence: 'high',
  }

  await upsertRealEstateDetails(db, '1', fields, 'openai/gpt-oss-120b', 'abc')

  expect(calls[0].sql).toContain('INSERT INTO real_estate_details')
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].sql).toContain('extracted_at = now()')
  expect(calls[0].params).toEqual([
    '1', 'sale', 'condo', 4500000, 'total', null, 35, 1, 1, 'Sheridan Tower', 'Mandaluyong',
    JSON.stringify(['rfo']), 'high', 'abc', 'openai/gpt-oss-120b',
  ])
})
