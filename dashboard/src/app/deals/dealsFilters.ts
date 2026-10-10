import type { DealsConfidenceTier } from '../../lib/queries'

export interface DealsFilters {
  search: string
  category: string | null
  minProfit: string
  minTier: DealsConfidenceTier | ''
  maxDaysListed: string
  addedWithinHours: string
  soldOnly: boolean
}

export const EMPTY_FILTERS: DealsFilters = {
  search: '',
  category: null,
  minProfit: '',
  minTier: '',
  maxDaysListed: '',
  addedWithinHours: '',
  soldOnly: false,
}

export function buildDealsParams(filters: DealsFilters, offset: number, lowConfidence: boolean): URLSearchParams {
  const params = new URLSearchParams({ offset: String(offset) })
  if (filters.search) params.set('search', filters.search)
  if (filters.category) params.set('category', filters.category)
  if (filters.minProfit) params.set('minProfit', filters.minProfit)
  if (filters.minTier) params.set('minTier', filters.minTier)
  if (filters.maxDaysListed) params.set('maxDaysListed', filters.maxDaysListed)
  if (filters.addedWithinHours) params.set('addedWithinHours', filters.addedWithinHours)
  if (filters.soldOnly) params.set('soldOnly', 'true')
  if (lowConfidence) params.set('lowConfidence', 'true')
  return params
}
