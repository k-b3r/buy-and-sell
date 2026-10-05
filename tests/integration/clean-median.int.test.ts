import { testDatabaseUrl } from './global-setup'
import { createDbPool } from '../../src/platform/storage'
import {
  computeMedians,
  decideListingDiscount,
  getComparableListings,
  getDeals,
  getPeerMedianPrice,
  getPriceReviewCandidates,
  getSoldComparablePrice,
  insertDiscountNotification,
  isPlaceholderPrice,
  medianCtes,
} from '../../src/modules/pricing'
import { getProductDetail, getProductSummaries } from '../../src/modules/catalog'
import { getListingDetail } from '../../src/modules/collection'

// One shared fixture set for every caller of the clean-median rule, SQL and
// JS alike. The first test is the rule's own contract (medianCtes agrees with
// computeMedians); the rest pin each caller's current output so a change to
// the shared rule shows up everywhere it lands.

const pool = createDbPool(testDatabaseUrl())

const PHONE = 9001
const EXCLUDED = 9002
const SINGLE = 9003
const EMPTY = 9004

const LISTINGS: { id: string; title: string; price: number; product: number; sold: boolean }[] = [
  { id: 'cm-a1', title: 'Phone A', price: 10000, product: PHONE, sold: false },
  { id: 'cm-a2', title: 'Phone A', price: 12000, product: PHONE, sold: false },
  { id: 'cm-a3', title: 'Phone B', price: 14000, product: PHONE, sold: false },
  { id: 'cm-a4', title: 'Phone C', price: 16000, product: PHONE, sold: false },
  { id: 'cm-a5', title: 'Phone D', price: 900, product: PHONE, sold: false },
  { id: 'cm-a6', title: 'Phone E', price: 123456, product: PHONE, sold: false },
  { id: 'cm-a7', title: 'Phone F', price: 4000, product: PHONE, sold: false },
  { id: 'cm-s1', title: 'Phone G', price: 9000, product: PHONE, sold: true },
  { id: 'cm-s2', title: 'Phone H', price: 11000, product: PHONE, sold: true },
  { id: 'cm-s3', title: 'Phone I', price: 13000, product: PHONE, sold: true },
  { id: 'cm-s4', title: 'Phone J', price: 200000, product: PHONE, sold: true },
  { id: 'cm-e1', title: 'Excluded A', price: 5000, product: EXCLUDED, sold: false },
  { id: 'cm-e2', title: 'Excluded B', price: 6000, product: EXCLUDED, sold: false },
  { id: 'cm-e3', title: 'Excluded C', price: 5000, product: EXCLUDED, sold: true },
  { id: 'cm-e4', title: 'Excluded D', price: 6000, product: EXCLUDED, sold: true },
  { id: 'cm-e5', title: 'Excluded E', price: 7000, product: EXCLUDED, sold: true },
  { id: 'cm-c1', title: 'Single A', price: 8000, product: SINGLE, sold: false },
]

const PRODUCT_IDS = [PHONE, EXCLUDED, SINGLE, EMPTY]
const LISTING_IDS = LISTINGS.map((l) => l.id)

async function clearFixtures(): Promise<void> {
  await pool.query('DELETE FROM discount_notifications WHERE product_id = ANY($1)', [PRODUCT_IDS])
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [LISTING_IDS])
  await pool.query('DELETE FROM products WHERE id = ANY($1)', [PRODUCT_IDS])
}

beforeAll(async () => {
  await clearFixtures()
  for (const [id, name, excluded] of [
    [PHONE, 'Fixture Phone', false],
    [EXCLUDED, 'Fixture Excluded', true],
    [SINGLE, 'Fixture Single', false],
    [EMPTY, 'Fixture Empty', false],
  ] as const) {
    await pool.query(
      `INSERT INTO products (id, base_model, base_model_normalized, price_lookup_excluded) VALUES ($1, $2, lower($2), $3)`,
      [id, name, excluded],
    )
  }
  for (const l of LISTINGS) {
    await pool.query(
      `INSERT INTO listings (id, title, price_amount, product_id, sold_at, raw_json)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, '{}')`,
      [l.id, l.title, l.price, l.product, l.sold],
    )
  }
})

afterAll(async () => {
  await clearFixtures()
  await pool.end()
})

function jsMedians(productId: number, scope: (l: (typeof LISTINGS)[number]) => boolean) {
  const prices = LISTINGS.filter((l) => l.product === productId && scope(l))
    .map((l) => l.price)
    .filter((p) => p > 0 && !isPlaceholderPrice(p))
  return computeMedians(prices)
}

async function sqlMedians(productId: number, soldClause: string) {
  const result = await pool.query(
    `WITH ${medianCtes({ name: 'm', pool: `SELECT product_id, price_amount FROM listings WHERE product_id = $1 AND ${soldClause}` })}
     SELECT raw_median_price, clean_median_price, sample_size FROM m`,
    [productId],
  )
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) return { rawMedian: null, cleanMedian: null, sampleSize: 0 }
  return {
    rawMedian: Number(row.raw_median_price),
    cleanMedian: row.clean_median_price === null ? null : Number(row.clean_median_price),
    sampleSize: Number(row.sample_size),
  }
}

test('medianCtes and computeMedians agree on every fixture product, for every listing scope', async () => {
  const scopes = [
    { sql: 'true', js: () => true },
    { sql: 'sold_at IS NULL', js: (l: (typeof LISTINGS)[number]) => !l.sold },
    { sql: 'sold_at IS NOT NULL', js: (l: (typeof LISTINGS)[number]) => l.sold },
  ]
  for (const productId of PRODUCT_IDS) {
    for (const scope of scopes) {
      expect(await sqlMedians(productId, scope.sql)).toEqual(jsMedians(productId, scope.js))
    }
  }
})

test('sold-comp and peer reference prices use the clean median, gated on sample size and exclusion', async () => {
  const results = {
    soldPhone: await getSoldComparablePrice(pool, PHONE),
    soldExcluded: await getSoldComparablePrice(pool, EXCLUDED),
    peerPhone: await getPeerMedianPrice(pool, PHONE),
    peerExcluded: await getPeerMedianPrice(pool, EXCLUDED),
    peerSingle: await getPeerMedianPrice(pool, SINGLE),
    peerEmpty: await getPeerMedianPrice(pool, EMPTY),
  }

  expect(results).toMatchInlineSnapshot(`
    {
      "peerEmpty": null,
      "peerExcluded": null,
      "peerPhone": {
        "medianPrice": 12000,
        "sampleSize": 6,
      },
      "peerSingle": null,
      "soldExcluded": null,
      "soldPhone": {
        "medianPrice": 11000,
        "sampleSize": 4,
      },
    }
  `)
})

test('comparable listings are the in-band rows behind the median, excluding the listing itself', async () => {
  const ids = async (sold: boolean) =>
    (await getComparableListings(pool, PHONE, 'cm-a1', sold)).map((c) => c.listing_id).sort()

  expect({ active: await ids(false), sold: await ids(true) }).toMatchInlineSnapshot(`
    {
      "active": [
        "cm-a2",
        "cm-a3",
        "cm-a4",
        "cm-a7",
      ],
      "sold": [
        "cm-s1",
        "cm-s2",
        "cm-s3",
      ],
    }
  `)
})

test('listing detail scores a discount against its siblings, including on an excluded product', async () => {
  const detail = async (id: string) => {
    const d = await getListingDetail(pool, id)
    return { price: d?.price_amount, discount: d?.discount_percent, reference: d?.reference_price }
  }

  expect({
    inBand: await detail('cm-a3'),
    outlier: await detail('cm-a5'),
    placeholder: await detail('cm-a6'),
    excludedProduct: await detail('cm-e1'),
    single: await detail('cm-c1'),
  }).toMatchInlineSnapshot(`
    {
      "excludedProduct": {
        "discount": 17,
        "price": 5000,
        "reference": 6000,
      },
      "inBand": {
        "discount": -22,
        "price": 14000,
        "reference": 11500,
      },
      "outlier": {
        "discount": null,
        "price": null,
        "reference": null,
      },
      "placeholder": {
        "discount": null,
        "price": null,
        "reference": null,
      },
      "single": {
        "discount": null,
        "price": 8000,
        "reference": null,
      },
    }
  `)
})

test('product list and product detail summarize discounts from the same clean median', async () => {
  const summaries = (await getProductSummaries(pool, { search: 'Fixture' }))
    .map((s) => ({
      id: s.id,
      min: s.price_min,
      max: s.price_max,
      best: s.best_discount_percent,
      count: s.discounted_listing_count,
      bands: s.discount_bands,
    }))
    .sort((a, b) => a.id - b.id)
  const detail = await getProductDetail(pool, PHONE)
  const detailDiscounts = Object.fromEntries((detail?.listings ?? []).map((l) => [l.id, l.discount_percent]))

  expect({ summaries, detailDiscounts }).toMatchInlineSnapshot(`
    {
      "detailDiscounts": {
        "cm-a1": 13,
        "cm-a2": -4,
        "cm-a3": -22,
        "cm-a4": -39,
        "cm-a5": null,
        "cm-a6": null,
        "cm-a7": 65,
        "cm-s1": 22,
        "cm-s2": 4,
        "cm-s3": -13,
        "cm-s4": null,
      },
      "summaries": [
        {
          "bands": [
            {
              "bandFloor": 60,
              "count": 1,
            },
            {
              "bandFloor": 20,
              "count": 1,
            },
            {
              "bandFloor": 10,
              "count": 1,
            },
          ],
          "best": 65,
          "count": 3,
          "id": 9001,
          "max": 16000,
          "min": 4000,
        },
        {
          "bands": [],
          "best": null,
          "count": 0,
          "id": 9002,
          "max": 6000,
          "min": 5000,
        },
        {
          "bands": [],
          "best": null,
          "count": 0,
          "id": 9003,
          "max": 8000,
          "min": 8000,
        },
      ],
    }
  `)
})

test('deals rank listings against sold comps, then peers, with the outlier guard', async () => {
  const deals = (await getDeals(pool, { minProfitPesos: 0, minPricePesos: 0 }, { search: 'Phone' }))
    .map((d) => ({
      id: d.listing_id,
      reference: d.reference_price,
      tier: d.tier,
      comps: d.comp_count,
      discount: d.discount_percent,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  expect(deals).toMatchInlineSnapshot(`
    [
      {
        "comps": 4,
        "discount": 9,
        "id": "cm-a1",
        "reference": 11000,
        "tier": "sold_comps",
      },
      {
        "comps": 4,
        "discount": 64,
        "id": "cm-a7",
        "reference": 11000,
        "tier": "sold_comps",
      },
    ]
  `)
})

test('discount detection falls back to the peer median across sold and active listings', async () => {
  const thresholds = { highDiscountThresholdPercent: 30, minProfitPesos: 1000, minPricePesos: 500 }
  const decided = [
    await decideListingDiscount(
      pool,
      { id: 'cm-a7', productId: PHONE, condition: 'Used - Good', priceAmount: 4000 },
      { retail: null, secondhand: null },
      thresholds,
    ),
    await decideListingDiscount(
      pool,
      { id: 'cm-e1', productId: EXCLUDED, condition: 'Used - Good', priceAmount: 5000 },
      { retail: null, secondhand: null },
      thresholds,
    ),
  ]
  for (const notification of decided) {
    if (notification) await insertDiscountNotification(pool, notification)
  }

  const result = await pool.query(
    'SELECT listing_id, discount_percent, reference_price FROM discount_notifications WHERE product_id = ANY($1)',
    [PRODUCT_IDS],
  )
  expect(result.rows).toMatchInlineSnapshot(`
    [
      {
        "discount_percent": 65,
        "listing_id": "cm-a7",
        "reference_price": "11500",
      },
    ]
  `)
})

test('price review flags magnitude outliers against the raw median of all a product listings', async () => {
  const ids = (await getPriceReviewCandidates(pool))
    .map((c) => c.id)
    .filter((id) => LISTING_IDS.includes(id))
    .sort()

  expect(ids).toMatchInlineSnapshot(`
    [
      "cm-a5",
      "cm-a6",
      "cm-s4",
    ]
  `)
})
