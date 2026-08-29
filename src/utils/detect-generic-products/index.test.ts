import { detectGenericBaseModel } from './index'

test('flags a bare category noun with no brand or model', () => {
  expect(detectGenericBaseModel('Air Conditioner')).toEqual({ reason: 'too_generic', matched: 'air conditioner' })
  expect(detectGenericBaseModel('Refrigerator')).toEqual({ reason: 'too_generic', matched: 'refrigerator' })
})

test('flags brand + bare category with no model/series - price spans an entire product tier', () => {
  expect(detectGenericBaseModel('Samsung Refrigerator')).toEqual({ reason: 'too_generic', matched: 'refrigerator' })
  expect(detectGenericBaseModel('Uniqlo Clothing')).toEqual({ reason: 'too_generic', matched: 'clothing' })
  expect(detectGenericBaseModel('Coach Bag')).toEqual({ reason: 'too_generic', matched: 'bag' })
})

test('does not flag a specific named product/style even when it ends in a generic-sounding word', () => {
  // Regression: an earlier suffix-only heuristic wrongly caught these because
  // it matched on the trailing word ("bag"/"wallet"/"keyboard") regardless of
  // how specific the preceding style name was. Exact-match-after-brand-strip
  // doesn't have this problem since the stripped remainder isn't a bare noun.
  expect(detectGenericBaseModel("A.P.C. Diane Rue Madame Tote Bag")).toBeNull()
  expect(detectGenericBaseModel('Coach Mila Wallet')).toBeNull()
  expect(detectGenericBaseModel('Apple Magic Keyboard')).toBeNull()
  expect(detectGenericBaseModel('Bose QuietComfort Wireless Headphones')).toBeNull()
  expect(detectGenericBaseModel('Adidas Ultraboost')).toBeNull()
})

test('does not flag a product with a model number/digit, even if otherwise brand+category-shaped', () => {
  expect(detectGenericBaseModel('iPhone 13')).toBeNull()
  expect(detectGenericBaseModel('HyperX Fury RAM 3200MHz')).toBeNull()
  expect(detectGenericBaseModel('Daikin Air Conditioner D-Smart Series')).toBeNull()
})

test('flags bare Apple product lines with no generation - same wide-price-spread problem', () => {
  expect(detectGenericBaseModel('iPhone')).toEqual({ reason: 'too_generic', matched: 'iphone' })
  expect(detectGenericBaseModel('iPad')).toEqual({ reason: 'too_generic', matched: 'ipad' })
  expect(detectGenericBaseModel('MacBook Pro')).toEqual({ reason: 'too_generic', matched: 'macbook pro' })
})

test('does not flag a recognizable vehicle/motorcycle nameplate, even though it repeats across years', () => {
  // Vehicles are deliberately exempt (unlike e.g. "Lenovo Thinkpad") - a
  // marketplace nameplate range (e.g. Mitsubishi Strada across model years)
  // is the expected/normal shape here, not a sign the product is unpriceable.
  expect(detectGenericBaseModel('Mitsubishi Strada')).toBeNull()
  expect(detectGenericBaseModel('Honda Click')).toBeNull()
  expect(detectGenericBaseModel('Toyota Vios')).toBeNull()
})

test('flags real estate by word boundary, not substring', () => {
  expect(detectGenericBaseModel('Vista Plumeria Condo')).toEqual({ reason: 'real_estate', matched: 'condo' })
  expect(detectGenericBaseModel('1BR Unit')).toEqual({ reason: 'real_estate', matched: expect.any(String) })
})

test('does not flag words that merely contain a real-estate hint as a substring', () => {
  // Regression: naive `"lot" in text` matched inside "c[lot]hes" and
  // "coins[lot]" - fixed by requiring \bword\b boundaries.
  expect(detectGenericBaseModel('Assorted Clothes')?.reason).not.toBe('real_estate')
  expect(detectGenericBaseModel('Coinslot')?.reason).not.toBe('real_estate')
})

test('flags a service, not a resold physical product', () => {
  expect(detectGenericBaseModel('TV Repair Service')).toEqual({ reason: 'service', matched: 'service' })
  expect(detectGenericBaseModel('Massage Service')).toEqual({ reason: 'service', matched: 'service' })
})

test('flags a part/accessory/bundle, not a single priceable product', () => {
  expect(detectGenericBaseModel('Motorcycle Parts')).toEqual({ reason: 'parts_accessory', matched: expect.any(String) })
  expect(detectGenericBaseModel('Clothes Bundle')).toEqual({ reason: 'parts_accessory', matched: expect.any(String) })
})

test('returns null for a real, specific, priceable product', () => {
  expect(detectGenericBaseModel('Motorola Razr 50 Ultra')).toBeNull()
  expect(detectGenericBaseModel('Seiko 5 Automatic Watch')).toBeNull()
  expect(detectGenericBaseModel('Nike Sabrina 1')).toBeNull()
})
