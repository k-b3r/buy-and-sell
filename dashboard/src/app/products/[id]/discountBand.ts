// Bands are decade-wide floors (10, 20, ...), see summarizeDiscounts in
// src/modules/pricing/price-rules.ts - a listing belongs to a band if its percent falls in
// [bandFloor, bandFloor + 10).
export function isInDiscountBand(percent: number | null, bandFloor: number): boolean {
  if (percent === null) return false
  return percent >= bandFloor && percent < bandFloor + 10
}
