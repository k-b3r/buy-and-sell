import { expect, test } from 'vitest'
import {
  hasActiveFilters,
  listingDetailHref,
  DEFAULT_LISTINGS_FILTERS,
  DEFAULT_HIDE_SOLD,
  DEFAULT_NEGOTIABLE_ONLY,
  DEFAULT_LISTED_WITHIN_DAYS,
  DEFAULT_SELECTED_BAND,
  DEFAULT_SORT_KEY,
  type ListingsFilters,
} from './listingsFilters'

const DEFAULT_FILTERS: ListingsFilters = {
  view: 'cards',
  sortKey: DEFAULT_SORT_KEY,
  listedWithinDays: DEFAULT_LISTED_WITHIN_DAYS,
  hideSold: DEFAULT_HIDE_SOLD,
  negotiableOnly: DEFAULT_NEGOTIABLE_ONLY,
  selectedBand: DEFAULT_SELECTED_BAND,
}

test('DEFAULT_LISTINGS_FILTERS is the cards view with every filter at its default', () => {
  expect(DEFAULT_LISTINGS_FILTERS).toEqual(DEFAULT_FILTERS)
})

test('hasActiveFilters is false for the defaults and ignores view and sort', () => {
  expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false)
  expect(hasActiveFilters({ ...DEFAULT_FILTERS, view: 'list', sortKey: 'price_asc' })).toBe(false)
})

test('hasActiveFilters is true when any filter differs from its default', () => {
  expect(hasActiveFilters({ ...DEFAULT_FILTERS, listedWithinDays: 7 })).toBe(true)
  expect(hasActiveFilters({ ...DEFAULT_FILTERS, hideSold: false })).toBe(true)
  expect(hasActiveFilters({ ...DEFAULT_FILTERS, negotiableOnly: true })).toBe(true)
  expect(hasActiveFilters({ ...DEFAULT_FILTERS, selectedBand: 20 })).toBe(true)
})

test('listingDetailHref links to the bare listing path when every filter is at its default', () => {
  expect(listingDetailHref('abc', DEFAULT_FILTERS)).toBe('/listings/abc')
})

test('listingDetailHref carries non-default filters as an encoded back param', () => {
  expect(listingDetailHref('abc', { ...DEFAULT_FILTERS, view: 'list', selectedBand: 20 })).toBe(
    `/listings/abc?back=${encodeURIComponent('view=list&band=20')}`,
  )
})
