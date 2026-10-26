import { positiveIntIdSchema } from '../../platform/positive-int-id'
import {
  dealsQuerySchema,
  excludedProductsQuerySchema,
  manualPriceSchema,
  notificationIdParamSchema,
  priceExclusionReasonSchema,
} from './schemas'

test('priceExclusionReasonSchema accepts every known reason and rejects anything else', () => {
  expect(priceExclusionReasonSchema.safeParse('manual_review').success).toBe(true)
  expect(priceExclusionReasonSchema.safeParse('retail_not_found').success).toBe(true)
  expect(priceExclusionReasonSchema.safeParse('because').success).toBe(false)
  expect(priceExclusionReasonSchema.safeParse(undefined).success).toBe(false)
})

test('manualPriceSchema accepts a kind with a positive ordered price range', () => {
  expect(manualPriceSchema.parse({ kind: 'new', priceLow: 1500, priceHigh: 2000 })).toEqual({
    kind: 'new',
    priceLow: 1500,
    priceHigh: 2000,
  })
  expect(manualPriceSchema.safeParse({ kind: 'secondhand', priceLow: 800, priceHigh: 800 }).success).toBe(true)
})

test.each([
  [{ kind: 'used', priceLow: 1, priceHigh: 2 }, 'kind must be "new" or "secondhand"'],
  [{}, 'kind must be "new" or "secondhand"'],
  [{ kind: 'new', priceLow: '1500', priceHigh: 2000 }, 'priceLow/priceHigh must be numbers'],
  [{ kind: 'new', priceLow: 1 }, 'priceLow/priceHigh must be numbers'],
  [{ kind: 'new', priceLow: null, priceHigh: 2 }, 'priceLow/priceHigh must be numbers'],
  [{ kind: 'new', priceLow: 0, priceHigh: 2 }, 'priceLow must be positive and not greater than priceHigh'],
  [{ kind: 'new', priceLow: 5, priceHigh: 2 }, 'priceLow must be positive and not greater than priceHigh'],
  [{ kind: 'new', priceLow: 1, priceHigh: -2 }, 'priceLow must be positive and not greater than priceHigh'],
])('manualPriceSchema rejects %j with the dashboard-facing message', (input, message) => {
  const result = manualPriceSchema.safeParse(input)

  expect(result.success).toBe(false)
  expect(result.error?.issues[0].message).toBe(message)
})

test('manualPriceSchema rejects a non-finite price', () => {
  const result = manualPriceSchema.safeParse({ kind: 'new', priceLow: 1, priceHigh: Number.POSITIVE_INFINITY })

  expect(result.success).toBe(false)
})

test('notificationIdParamSchema accepts a positive integer string only', () => {
  expect(notificationIdParamSchema.parse('15')).toBe(15)
  for (const raw of ['0', '-1', '1.5', 'abc', '']) {
    expect(notificationIdParamSchema.safeParse(raw).success).toBe(false)
  }
})

test('notificationIdParamSchema is the shared positive-integer id schema and keeps its 400 body', () => {
  expect(notificationIdParamSchema).toBe(positiveIntIdSchema)

  const result = notificationIdParamSchema.safeParse('0')
  expect(result.error?.issues[0].message).toBe('id must be a positive integer')
})

test('dealsQuerySchema defaults to no filters and offset 0', () => {
  expect(dealsQuerySchema.parse({})).toEqual({
    filters: {
      search: undefined,
      categories: undefined,
      minProfitPesos: undefined,
      minConfidenceTier: undefined,
      maxDaysListed: undefined,
      addedWithinHours: undefined,
      soldOnly: false,
      lowConfidenceOnly: false,
    },
    offset: 0,
  })
})

test('dealsQuerySchema reads every filter param', () => {
  const parsed = dealsQuerySchema.parse({
    search: 'iphone',
    category: ['Phones', 'Laptops'],
    minProfit: '2500',
    minTier: 'peer_listings',
    maxDaysListed: '14',
    addedWithinHours: '6',
    soldOnly: 'true',
    lowConfidence: 'true',
    offset: '30',
  })

  expect(parsed).toEqual({
    filters: {
      search: 'iphone',
      categories: ['Phones', 'Laptops'],
      minProfitPesos: 2500,
      minConfidenceTier: 'peer_listings',
      maxDaysListed: 14,
      addedWithinHours: 6,
      soldOnly: true,
      lowConfidenceOnly: true,
    },
    offset: 30,
  })
})

test('dealsQuerySchema drops an unknown tier and a bad addedWithinHours instead of failing', () => {
  const parsed = dealsQuerySchema.parse({ minTier: 'vibes', addedWithinHours: '-3' })

  expect(parsed.filters.minConfidenceTier).toBeUndefined()
  expect(parsed.filters.addedWithinHours).toBeUndefined()
})

test('dealsQuerySchema treats a blank search or numeric filter as not given', () => {
  const parsed = dealsQuerySchema.parse({ search: '', minProfit: '', maxDaysListed: '' })

  expect(parsed.filters.search).toBeUndefined()
  expect(parsed.filters.minProfitPesos).toBeUndefined()
  expect(parsed.filters.maxDaysListed).toBeUndefined()
})

test.each([{ minProfit: 'abc' }, { maxDaysListed: 'x' }, { offset: '-1' }, { offset: 'abc' }])(
  'dealsQuerySchema rejects %j',
  (query) => {
    expect(dealsQuerySchema.safeParse(query).success).toBe(false)
  },
)

test('excludedProductsQuerySchema requires a reason and bounds paging', () => {
  expect(excludedProductsQuerySchema.parse({ reason: 'groq_generic' })).toEqual({
    reason: 'groq_generic',
    offset: 0,
    limit: undefined,
  })
  expect(excludedProductsQuerySchema.parse({ reason: 'x', offset: '100', limit: '50' })).toEqual({
    reason: 'x',
    offset: 100,
    limit: 50,
  })
  expect(excludedProductsQuerySchema.safeParse({}).success).toBe(false)
  expect(excludedProductsQuerySchema.safeParse({ reason: 'x', limit: '0' }).success).toBe(false)
  expect(excludedProductsQuerySchema.safeParse({ reason: 'x', limit: '9999' }).success).toBe(false)
})
