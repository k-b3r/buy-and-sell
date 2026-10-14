import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  getDeals,
  getExcludedProducts,
  getExclusionSummary,
  getProductDetail,
  getProductSummaries,
  getRealEstateListings,
} from './queries'

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

test('getProductSummaries sends search, repeated filters and offset to the products route', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ products: [{ id: 1 }], nextOffset: 60 })))

  const page = await getProductSummaries({
    search: 'iphone',
    categories: ['Phones', 'Laptops'],
    subCategories: ['Mac'],
    offset: 30,
  })

  expect(page).toEqual({ products: [{ id: 1 }], nextOffset: 60 })
  const url = new URL(fetchMock.mock.calls[0][0] as string)
  expect(url.pathname).toBe('/products')
  expect(url.searchParams.get('q')).toBe('iphone')
  expect(url.searchParams.getAll('category')).toEqual(['Phones', 'Laptops'])
  expect(url.searchParams.getAll('subCategory')).toEqual(['Mac'])
  expect(url.searchParams.get('offset')).toBe('30')
})

test('getProductDetail unwraps the product and passes null through for an unknown id', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ product: null })))

  expect(await getProductDetail(999)).toBeNull()
  expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/products/999')
})

test('getDeals sends the filters as URL params and returns the page with its next offset', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ deals: [{ listing_id: 'a' }], nextOffset: 30 })))

  const page = await getDeals({
    search: 'iphone',
    categories: ['Phones', 'Laptops'],
    minProfitPesos: 2500,
    minConfidenceTier: 'sold_comps',
    maxDaysListed: 14,
    addedWithinHours: 6,
    soldOnly: true,
    lowConfidenceOnly: true,
    offset: 30,
  })

  expect(page).toEqual({ deals: [{ listing_id: 'a' }], nextOffset: 30 })
  const url = new URL(fetchMock.mock.calls[0][0] as string)
  expect(url.pathname).toBe('/deals')
  expect(url.searchParams.getAll('category')).toEqual(['Phones', 'Laptops'])
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    search: 'iphone',
    minProfit: '2500',
    minTier: 'sold_comps',
    maxDaysListed: '14',
    addedWithinHours: '6',
    soldOnly: 'true',
    lowConfidence: 'true',
    offset: '30',
  })
})

test('getDeals sends no params when no filters are given', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ deals: [], nextOffset: null })))

  await getDeals()

  expect(new URL(fetchMock.mock.calls[0][0] as string).search).toBe('')
})

test('getExcludedProducts asks for one reason with its paging and unwraps the products', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ products: [{ id: 1 }] })))

  const products = await getExcludedProducts('groq_generic', { offset: 50, limit: 50 })

  expect(products).toEqual([{ id: 1 }])
  const url = new URL(fetchMock.mock.calls[0][0] as string)
  expect(url.pathname).toBe('/price-exclusions')
  expect(Object.fromEntries(url.searchParams)).toEqual({ reason: 'groq_generic', offset: '50', limit: '50' })
})

test('getExclusionSummary unwraps the reason groups', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ summary: [{ reason: 'x', count: 1, retry: false }] })))

  expect(await getExclusionSummary()).toEqual([{ reason: 'x', count: 1, retry: false }])
  expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/price-exclusions/summary')
})
