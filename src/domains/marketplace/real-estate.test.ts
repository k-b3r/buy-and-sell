import {
  parsePriceShorthand,
  normalizeNcrArea,
  normalizeRealEstateItem,
  buildRealEstatePrompt,
  NCR_LGUS,
} from './real-estate'
import type { RealEstateCandidate } from './real-estate'

const candidate = (over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id: '1',
  title: 'Condo for sale',
  description: null,
  price_amount: 4500000,
  source_hash: 'h',
  ...over,
})

const raw = (over: Record<string, unknown> = {}) => ({
  id: '1',
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 4500000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Sheridan Tower',
  area_text: 'Mandaluyong',
  tags: ['rfo'],
  confidence: 'high',
  ...over,
})

test('parsePriceShorthand reads M, mil, k and peso-prefixed amounts', () => {
  expect(parsePriceShorthand('1 bedroom 13M unit')).toEqual([13000000])
  expect(parsePriceShorthand('P1.5M only')).toEqual([1500000])
  expect(parsePriceShorthand('downpayment 500k')).toEqual([500000])
  expect(parsePriceShorthand('2 mil negotiable')).toEqual([2000000])
  expect(parsePriceShorthand('₱ 45k/month')).toEqual([45000])
})

test('parsePriceShorthand ignores areas and dimensions', () => {
  expect(parsePriceShorthand('128 sqm 3-bedroom')).toEqual([])
  expect(parsePriceShorthand('lot 5m x 10m')).toEqual([])
})

test('normalizeNcrArea maps aliases and keeps unknown text as is', () => {
  expect(normalizeNcrArea('BGC')).toBe('Taguig')
  expect(normalizeNcrArea('near Eastwood City')).toBe('Quezon City')
  expect(normalizeNcrArea('las pinas')).toBe('Las Piñas')
  expect(normalizeNcrArea('Makati')).toBe('Makati')
  expect(normalizeNcrArea('Antipolo')).toBe('Antipolo')
  expect(normalizeNcrArea(null)).toBeNull()
  expect(NCR_LGUS).toHaveLength(17)
})

test('normalizeRealEstateItem keeps a valid item as is', () => {
  const f = normalizeRealEstateItem(raw(), candidate())!
  expect(f).toMatchObject({
    listing_type: 'sale',
    property_type: 'condo',
    price_php: 4500000,
    price_basis: 'total',
    floor_sqm: 35,
    bedrooms: 1,
    area_text: 'Mandaluyong',
    confidence: 'high',
    tags: ['rfo'],
  })
})

test('normalizeRealEstateItem treats unknown listing_type as null and unknown property_type as other', () => {
  const f = normalizeRealEstateItem(raw({ listing_type: 'unknown', property_type: 'spaceship' }), candidate())!
  expect(f.listing_type).toBeNull()
  expect(f.property_type).toBe('other')
})

test('normalizeRealEstateItem nulls an implausible price and falls back to a plausible raw price at medium confidence', () => {
  const f = normalizeRealEstateItem(raw({ price_php: 13, price_basis: 'total' }), candidate({ price_amount: 4500000 }))!
  expect(f.price_php).toBe(4500000)
  expect(f.price_basis).toBe('total')
  expect(f.confidence).toBe('medium')
})

test('normalizeRealEstateItem marks price unresolved and confidence low when nothing is plausible', () => {
  const f = normalizeRealEstateItem(
    raw({ price_php: null, price_basis: 'unresolved' }),
    candidate({ price_amount: 13 }),
  )!
  expect(f.price_php).toBeNull()
  expect(f.price_basis).toBe('unresolved')
  expect(f.confidence).toBe('low')
})

test('normalizeRealEstateItem uses monthly as the raw-price fallback basis for rentals', () => {
  const f = normalizeRealEstateItem(
    raw({ listing_type: 'rent', price_php: null, price_basis: 'unresolved' }),
    candidate({ price_amount: 25000 }),
  )!
  expect(f.price_php).toBe(25000)
  expect(f.price_basis).toBe('monthly')
})

test('normalizeRealEstateItem nulls implausible areas and bedroom counts', () => {
  const f = normalizeRealEstateItem(
    raw({ lot_sqm: 99999999, floor_sqm: 0, bedrooms: 400, bathrooms: -2 }),
    candidate(),
  )!
  expect(f.lot_sqm).toBeNull()
  expect(f.floor_sqm).toBeNull()
  expect(f.bedrooms).toBeNull()
  expect(f.bathrooms).toBeNull()
})

test('normalizeRealEstateItem normalizes area_text to an NCR name and drops unknown tags', () => {
  const f = normalizeRealEstateItem(raw({ area_text: 'BGC', tags: ['rfo', 'haunted'] }), candidate())!
  expect(f.area_text).toBe('Taguig')
  expect(f.tags).toEqual(['rfo'])
})

test('normalizeRealEstateItem returns null for a malformed item', () => {
  expect(normalizeRealEstateItem(null, candidate())).toBeNull()
  expect(normalizeRealEstateItem({ id: '1' }, candidate())).toBeNull()
})

test('buildRealEstatePrompt lists each listing with its raw price and text amounts', () => {
  const prompt = buildRealEstatePrompt([candidate({ id: '9', title: '1BR Portico 13M', price_amount: 13 })])
  expect(prompt).toContain('"id":"9"')
  expect(prompt).toContain('"listed_price":13')
  expect(prompt).toContain('13000000')
  expect(prompt).toContain('Taguig')
})

test('normalizeRealEstateItem keeps 0 bedrooms only for a condo (studio) and nulls zero bathrooms', () => {
  expect(
    normalizeRealEstateItem(raw({ property_type: 'condo', bedrooms: 0, bathrooms: 1 }), candidate())!.bedrooms,
  ).toBe(0)
  expect(normalizeRealEstateItem(raw({ property_type: 'land', bedrooms: 0 }), candidate())!.bedrooms).toBeNull()
  expect(normalizeRealEstateItem(raw({ property_type: 'commercial', bedrooms: 0 }), candidate())!.bedrooms).toBeNull()
  expect(normalizeRealEstateItem(raw({ bathrooms: 0 }), candidate())!.bathrooms).toBeNull()
})

test('normalizeRealEstateItem treats a pasalo cash-out read as a total as equity when no selling price is stated', () => {
  const pasalo = candidate({
    title: 'House and Lot pasalo in Las Piñas City',
    description: 'Lot area: 35.97sqm Floor area: 42sqm Remaining balance: 820k Asking cash out: 1.6M Negotiable',
    price_amount: 16,
  })
  const f = normalizeRealEstateItem(
    raw({
      property_type: 'house_and_lot',
      price_php: 1600000,
      price_basis: 'total',
      tags: ['pasalo'],
      confidence: 'high',
    }),
    pasalo,
  )!
  expect(f.price_basis).toBe('equity')
  expect(f.confidence).toBe('medium')
})

test('normalizeRealEstateItem keeps a pasalo total when the text states the selling price', () => {
  const pasalo = candidate({
    title: 'Rush Sale Pasalo Condo Vista Plumeria',
    description: 'Selling Price: 3,550,000 Asking downpayment: 1,905,807 Remaining balance: 1,644,193',
    price_amount: 1900000,
  })
  const f = normalizeRealEstateItem(raw({ price_php: 3550000, price_basis: 'total', tags: ['pasalo'] }), pasalo)!
  expect(f.price_basis).toBe('total')
  expect(f.price_php).toBe(3550000)
})

test('normalizeRealEstateItem tags room, bedspace and roommate listings as room_share', () => {
  for (const title of [
    'Male Condo Roommate | Beside LRT Gil Puyat',
    'Condo Sharing - Room for Rent at EDSA Boni',
    'Bedspace for rent near UST',
  ]) {
    const f = normalizeRealEstateItem(
      raw({ listing_type: 'rent', price_php: 9000, price_basis: 'monthly', tags: [] }),
      candidate({ title }),
    )!
    expect(f.tags).toContain('room_share')
  }
  const whole = normalizeRealEstateItem(
    raw({ listing_type: 'rent', price_php: 15000, price_basis: 'monthly' }),
    candidate({ title: '2BR condo for rent, 3 rooms total' }),
  )!
  expect(whole.tags).not.toContain('room_share')
})

test('buildRealEstatePrompt explains pasalo cash-out, condo detection and room shares', () => {
  const prompt = buildRealEstatePrompt([candidate()])
  expect(prompt).toContain('cash out')
  expect(prompt).toContain('room_share')
  expect(prompt).toContain('parking slot')
})
