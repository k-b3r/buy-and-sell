import type { PriceRange } from './price-lookup'
import { isJunkPrice, MIN_PEER_SAMPLE } from './clean-median'

// Junk prices would badly skew a naive min/max.
export function computePriceRangeFromPrices(prices: number[]): (PriceRange & { usedCount: number }) | null {
  const valid = prices.filter((p) => !isJunkPrice(p))
  if (valid.length < MIN_PEER_SAMPLE) return null
  return {
    low: Math.min(...valid),
    high: Math.max(...valid),
    currency: 'PHP',
    usedCount: valid.length,
  }
}
