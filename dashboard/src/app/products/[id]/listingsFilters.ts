// Plain module (no 'use client') - parseListingsFilters is called from
// ProductDetailPage (a Server Component) to seed ListingsView, and a client
// export can't be invoked from the server, so this logic can't live inside
// ListingsView.tsx itself despite being ListingsView-specific.

export type View = 'list' | 'cards'
export type SortKey = 'discount_desc' | 'discount_asc' | 'price_asc' | 'price_desc' | 'listed_newest' | 'listed_oldest'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'discount_desc', label: 'Discount: high to low' },
  { value: 'discount_asc', label: 'Discount: low to high' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'listed_newest', label: 'Listed: newest first' },
  { value: 'listed_oldest', label: 'Listed: oldest first' },
]

export const LISTED_WITHIN_OPTIONS = [
  { value: 0, label: 'Any time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
]

// Filter defaults, not display-preference defaults (view/sort) - what
// ListingsView's "Clear" resets. hideSold defaults to true (the app's
// normal starting state, per direct instruction 2026-08-23), so Clear
// returns to that, not to "show everything."
export const DEFAULT_VIEW: View = 'cards'
export const DEFAULT_SORT_KEY: SortKey = 'discount_desc'
export const DEFAULT_LISTED_WITHIN_DAYS = 0
export const DEFAULT_HIDE_SOLD = true
export const DEFAULT_NEGOTIABLE_ONLY = false
export const DEFAULT_SELECTED_BAND = null

export interface ListingsFilters {
  view: View
  sortKey: SortKey
  listedWithinDays: number
  hideSold: boolean
  negotiableOnly: boolean
  selectedBand: number | null
}

// Parses the `back` querystring a listing link (ListingsView) carried, into
// the filter state it was built from - lets ProductDetailPage seed
// ListingsView with whatever was active before the user clicked into a
// listing, instead of always starting over at the hardcoded defaults
// (confirmed live 2026-08-29: clicking a listing then "Back to X" reset
// sort/hide-sold/discount-band/etc. every time - this component had no URL
// awareness at all, unlike the outer product list's category/sub-category
// filters).
export function parseListingsFilters(params: URLSearchParams): ListingsFilters {
  const sortParam = params.get('sort')
  const bandParam = params.get('band')
  const parsedBand = bandParam !== null ? Number(bandParam) : NaN
  return {
    view: params.get('view') === 'list' ? 'list' : DEFAULT_VIEW,
    sortKey: SORT_OPTIONS.some((o) => o.value === sortParam) ? (sortParam as SortKey) : DEFAULT_SORT_KEY,
    listedWithinDays: LISTED_WITHIN_OPTIONS.some((o) => o.value === Number(params.get('listedWithin')))
      ? Number(params.get('listedWithin'))
      : DEFAULT_LISTED_WITHIN_DAYS,
    hideSold: params.has('hideSold') ? params.get('hideSold') === '1' : DEFAULT_HIDE_SOLD,
    negotiableOnly: params.get('negotiable') === '1',
    selectedBand: Number.isFinite(parsedBand) ? parsedBand : DEFAULT_SELECTED_BAND,
  }
}

// Inverse of parseListingsFilters - only writes params that differ from the
// default, so an unfiltered view still links to a bare `/listings/${id}`.
export function buildListingsQueryString(filters: ListingsFilters): string {
  const params = new URLSearchParams()
  if (filters.view !== DEFAULT_VIEW) params.set('view', filters.view)
  if (filters.sortKey !== DEFAULT_SORT_KEY) params.set('sort', filters.sortKey)
  if (filters.listedWithinDays !== DEFAULT_LISTED_WITHIN_DAYS) params.set('listedWithin', String(filters.listedWithinDays))
  if (filters.hideSold !== DEFAULT_HIDE_SOLD) params.set('hideSold', filters.hideSold ? '1' : '0')
  if (filters.negotiableOnly !== DEFAULT_NEGOTIABLE_ONLY) params.set('negotiable', '1')
  if (filters.selectedBand !== DEFAULT_SELECTED_BAND) params.set('band', String(filters.selectedBand))
  return params.toString()
}
