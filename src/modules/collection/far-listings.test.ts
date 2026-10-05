import type { DbClient } from '../../platform/storage'
import type { ImageStore } from '../../platform/images'
import type { Logger } from '../../platform/logger'
import { filterFarCandidates, purgeFarListings } from './far-listings'

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

test('filterFarCandidates keeps only rows outside the 80km Manila radius', () => {
  const rows = [
    { id: 'near', location_lat: '14.5896', location_lng: '120.9808' },
    { id: 'far-cebu', location_lat: '10.3157', location_lng: '123.8854' },
    { id: 'no-coords', location_lat: null, location_lng: null },
  ]
  expect(filterFarCandidates(rows)).toEqual([{ id: 'far-cebu', lat: 10.3157, lng: 123.8854 }])
})

test('purgeFarListings deletes photos then the row for every far candidate', async () => {
  const deletedPhotoIds: string[] = []
  const imageStore: ImageStore = {
    put: async () => '',
    deleteAll: async (prefix) => {
      deletedPhotoIds.push(prefix)
    },
  }
  const deletedRowIds: string[] = []
  const db: DbClient = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('DELETE FROM listings')) deletedRowIds.push(params[0] as string)
      return { rows: [] }
    },
  }

  const count = await purgeFarListings(db, silentLogger(), imageStore, [
    { id: 'far-1', lat: 10.3157, lng: 123.8854 },
    { id: 'far-2', lat: 16.4, lng: 120.6 },
  ])

  expect(count).toBe(2)
  expect(deletedPhotoIds).toEqual(['listings/far-1/', 'listings/far-2/'])
  expect(deletedRowIds).toEqual(['far-1', 'far-2'])
})
