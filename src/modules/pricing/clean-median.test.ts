import { expect, test } from 'vitest'
import {
  computeMedians,
  isMagnitudeOutlier,
  isJunkPrice,
  isPlaceholderPrice,
  medianCtes,
  notJunkPriceSql,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
} from './clean-median'

test('isJunkPrice flags a price below the ₱100 floor or with a placeholder digit pattern', () => {
  expect(isJunkPrice(0)).toBe(true)
  expect(isJunkPrice(-5)).toBe(true)
  expect(isJunkPrice(12)).toBe(true)
  expect(isJunkPrice(99)).toBe(true)
  expect(isJunkPrice(12345)).toBe(true)
  expect(isJunkPrice(100)).toBe(false)
  expect(isJunkPrice(15000)).toBe(false)
})

test('notJunkPriceSql bounds the column at the floor and rejects placeholder patterns', () => {
  expect(notJunkPriceSql('l.price_amount')).toBe(`l.price_amount >= 100 AND ${notPlaceholderPriceSql('l.price_amount')}`)
})

test('isPlaceholderPrice flags ascending-sequential digit runs', () => {
  expect(isPlaceholderPrice(123)).toBe(true)
  expect(isPlaceholderPrice(1234)).toBe(true)
  expect(isPlaceholderPrice(12345)).toBe(true)
  expect(isPlaceholderPrice(123456)).toBe(true)
})

test('isPlaceholderPrice flags an ascending run embedded anywhere in the price, not just starting at 1', () => {
  // real listing found live 2026-08-23: ₱12,456 - a "1,2" run followed by a
  // "4,5,6" run, not a clean prefix of 123456789, but still placeholder-like.
  expect(isPlaceholderPrice(12456)).toBe(true)
  expect(isPlaceholderPrice(23456)).toBe(true)
  expect(isPlaceholderPrice(56789)).toBe(true)
})

test('isPlaceholderPrice flags repeated-single-digit runs', () => {
  expect(isPlaceholderPrice(111)).toBe(true)
  expect(isPlaceholderPrice(9999)).toBe(true)
  expect(isPlaceholderPrice(55555)).toBe(true)
})

test('isPlaceholderPrice flags repeated multi-digit block runs (e.g. joke/meme numbers)', () => {
  expect(isPlaceholderPrice(6969)).toBe(true)
  expect(isPlaceholderPrice(696969)).toBe(true)
  expect(isPlaceholderPrice(4242)).toBe(true)
  expect(isPlaceholderPrice(123123)).toBe(true)
})

test('isPlaceholderPrice does not flag real round prices', () => {
  expect(isPlaceholderPrice(500)).toBe(false)
  expect(isPlaceholderPrice(1000)).toBe(false)
  expect(isPlaceholderPrice(15000)).toBe(false)
  expect(isPlaceholderPrice(29999)).toBe(false)
})

test('isPlaceholderPrice does not flag ordinary non-pattern prices', () => {
  expect(isPlaceholderPrice(17499)).toBe(false)
  expect(isPlaceholderPrice(32500)).toBe(false)
})

test('isMagnitudeOutlier is true for a price >10x or <0.1x the raw median', () => {
  expect(isMagnitudeOutlier(999999999, 15000)).toBe(true)
  expect(isMagnitudeOutlier(10, 15000)).toBe(true)
})

test('isMagnitudeOutlier is false for a price within 10x of the raw median', () => {
  expect(isMagnitudeOutlier(12000, 15000)).toBe(false)
  expect(isMagnitudeOutlier(150000, 15000)).toBe(false) // exactly 10x, boundary inclusive
})

test('isMagnitudeOutlier is false when there is no median to compare against', () => {
  expect(isMagnitudeOutlier(12000, null)).toBe(false)
})

test('isMagnitudeOutlier treats every price as an outlier against a non-positive reference', () => {
  expect(isMagnitudeOutlier(12000, 0)).toBe(true)
  expect(isMagnitudeOutlier(12000, -500)).toBe(true)
})

test('computeMedians interpolates the two middle values for an even-sized sample, like percentile_cont', () => {
  expect(computeMedians([1000, 2000, 3000, 4000])).toEqual({ rawMedian: 2500, cleanMedian: 2500, sampleSize: 4 })
})

test('computeMedians drops prices more than 10x off the raw median before taking the clean median', () => {
  expect(computeMedians([150, 15000, 16000, 17000, 900000])).toEqual({
    rawMedian: 16000,
    cleanMedian: 16000,
    sampleSize: 5,
  })
  expect(computeMedians([1500, 15000, 16000, 17000])).toEqual({ rawMedian: 15500, cleanMedian: 16000, sampleSize: 4 })
})

test('computeMedians drops junk and missing prices before taking any median', () => {
  expect(computeMedians([null, 12, 12345, 1000, 2000, 3000, 4000])).toEqual({
    rawMedian: 2500,
    cleanMedian: 2500,
    sampleSize: 4,
  })
})

test('computeMedians has no medians for an empty sample', () => {
  expect(computeMedians([])).toEqual({ rawMedian: null, cleanMedian: null, sampleSize: 0 })
})

test('notMagnitudeOutlierSql keeps a row with no median, drops it against a non-positive one, otherwise bounds it at 10x either way', () => {
  expect(notMagnitudeOutlierSql('l.price_amount', 'm.raw_median_price')).toBe(
    '(m.raw_median_price IS NULL OR (m.raw_median_price > 0 AND l.price_amount BETWEEN m.raw_median_price / 10 AND m.raw_median_price * 10))',
  )
})

test('medianCtes filters the pool to valid prices and gates the clean median on the minimum sample', () => {
  const sql = medianCtes({ name: 'peer', pool: 'SELECT product_id, price_amount FROM listings', minSample: 3 })

  expect(sql).toContain('peer_prices AS (')
  expect(sql).toContain('SELECT * FROM (SELECT product_id, price_amount FROM listings) pool')
  expect(sql).toContain(`price_amount IS NOT NULL AND ${notJunkPriceSql('price_amount')}`)
  expect(sql).toContain('peer_raw AS (')
  expect(sql).toContain('GROUP BY product_id')
  expect(sql).toContain('peer AS (')
  expect(sql).toContain('r.sample_size >= 3')
  expect(sql).toContain(notMagnitudeOutlierSql('pp.price_amount', 'r.raw_median_price'))
  expect(sql).toContain('AS clean_median_price')
})

test('medianCtes with clean false emits only the raw median, skipping the second percentile pass', () => {
  const sql = medianCtes({
    name: 'product_median',
    pool: 'SELECT product_id, price_amount FROM listings',
    clean: false,
  })

  expect(sql).toContain('product_median AS (')
  expect(sql).toContain('AS raw_median_price')
  expect(sql).not.toContain('product_median_raw')
  expect(sql).not.toContain('clean_median_price')
})
