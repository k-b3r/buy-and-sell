import { expect, test } from 'vitest'
import { EMPTY_FILTERS, buildDealsParams } from './dealsFilters'

test('buildDealsParams sends only the offset for empty filters', () => {
  expect(buildDealsParams(EMPTY_FILTERS, 0, false).toString()).toBe('offset=0')
})

test('buildDealsParams sends every set filter plus the low-confidence flag', () => {
  const params = buildDealsParams(
    {
      search: 'iphone',
      category: 'Phones',
      minProfit: '1000',
      minTier: 'peer_listings',
      maxDaysListed: '7',
      soldOnly: true,
    },
    30,
    true,
  )
  expect(params.toString()).toBe(
    'offset=30&search=iphone&category=Phones&minProfit=1000&minTier=peer_listings&maxDaysListed=7&soldOnly=true&lowConfidence=true',
  )
})
