import type { ListingPhotos } from '../src/modules/collection'
import type { QueryClient } from '../src/platform/storage'
import { createRefreshHandlers } from './refreshHandlers'

const noopLogger = { info() {}, warn() {}, error() {} }

function handlers() {
  return createRefreshHandlers({
    db: {} as QueryClient,
    photos: {} as ListingPhotos,
    logger: noopLogger,
    env: {},
    cache: { invalidate() {} },
  })
}

test('createRefreshHandlers returns the single-listing, product, job status and job cancel handlers', () => {
  expect(Object.keys(handlers()).sort()).toEqual(['cancelJob', 'jobStatus', 'refresh', 'refreshProduct'])
})

test('the job status handler reports no job before one has started', async () => {
  const result = await handlers().jobStatus(undefined)
  expect(result).toEqual({ statusCode: 200, body: null })
})
