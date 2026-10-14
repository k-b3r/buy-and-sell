import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getRealEstateListings } from './queries'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('REFRESH_SERVER_URL', 'https://vps.test')
  vi.stubEnv('REFRESH_API_KEY', 'test-key')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ listings: [{ id: 'a' }], nextPage: null })))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

test('getRealEstateListings asks the server route with the filters as URL params and returns the listings', async () => {
  const listings = await getRealEstateListings({
    listingType: 'sale',
    propertyType: 'condo',
    area: 'Pasig',
    minPrice: 1000,
    view: 'review',
    includeRoomShares: true,
    limit: 30,
    offset: 60,
  })

  expect(listings).toEqual([{ id: 'a' }])
  const url = new URL(fetchMock.mock.calls[0][0] as string)
  expect(url.origin + url.pathname).toBe('https://vps.test/real-estate')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    kind: 'sale',
    type: 'condo',
    area: 'Pasig',
    min: '1000',
    view: 'review',
    rooms: '1',
    page: '3',
  })
})

test('getRealEstateListings asks for page 1 when no filters are given', async () => {
  await getRealEstateListings()

  const url = new URL(fetchMock.mock.calls[0][0] as string)
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: '1' })
})
