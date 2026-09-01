// Hardcoded, not a per-run setting: this project only ever operates in Metro
// Manila. FB's own filter_radius_km (see browser.ts fetchNextPage) is sent to
// Facebook but never enforced locally, so a listing whose seller-set location
// is nowhere near Manila can still surface in results — this is the local
// backstop that actually rejects it.
export const MANILA_CENTER = { lat: 14.5896, lng: 120.9808 }
export const MAX_SERVICE_RADIUS_KM = 80

const EARTH_RADIUS_KM = 6371

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const sinDLat = Math.sin(dLat / 2)
  const sinDLng = Math.sin(dLng / 2)
  const h =
    sinDLat * sinDLat +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinDLng * sinDLng
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

// Fails open when a listing has no location data at all - there's nothing to
// verify against, and rejecting on missing data would also drop legitimately
// nearby listings whose location field FB simply omitted.
export function isWithinServiceArea(listing: Record<string, unknown>): boolean {
  const location = listing.location as { latitude?: number; longitude?: number } | undefined
  if (location?.latitude == null || location?.longitude == null) return true
  const km = distanceKm(MANILA_CENTER, { lat: location.latitude, lng: location.longitude })
  return km <= MAX_SERVICE_RADIUS_KM
}
