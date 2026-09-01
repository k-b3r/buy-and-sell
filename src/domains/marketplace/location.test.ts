import { isWithinServiceArea, distanceKm, MANILA_CENTER, MAX_SERVICE_RADIUS_KM } from './location'

test('listing at the service area center is within range', () => {
  expect(isWithinServiceArea({ location: { latitude: MANILA_CENTER.lat, longitude: MANILA_CENTER.lng } })).toBe(true)
})

test('listing just under the radius is within range', () => {
  // ~74km north of Manila, inside the 80km radius
  expect(isWithinServiceArea({ location: { latitude: 15.25, longitude: 120.9808 } })).toBe(true)
})

test('listing far outside the radius is rejected', () => {
  // Cebu City, ~570km from Manila
  expect(isWithinServiceArea({ location: { latitude: 10.3157, longitude: 123.8854 } })).toBe(false)
})

test('listing with no location data is not rejected (nothing to verify against)', () => {
  expect(isWithinServiceArea({})).toBe(true)
})

test('distanceKm is ~0 for identical points and matches known Manila-Cebu distance', () => {
  expect(distanceKm(MANILA_CENTER, MANILA_CENTER)).toBe(0)
  const cebu = { lat: 10.3157, lng: 123.8854 }
  const km = distanceKm(MANILA_CENTER, cebu)
  expect(km).toBeGreaterThan(550)
  expect(km).toBeLessThan(600)
})

test('MAX_SERVICE_RADIUS_KM is hardcoded to 80', () => {
  expect(MAX_SERVICE_RADIUS_KM).toBe(80)
})
