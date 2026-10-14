import { expect, test } from 'vitest'
import {
  DISCOUNT_SUMMARY_LATERAL,
  medianCtes,
  notJunkPriceSql,
  notPlaceholderPriceSql,
  notMagnitudeOutlierSql,
  peerListingSql,
} from './fragments'

test('peerListingSql keeps active listings, listings sold in the last 30 days and listings flagged removed in the last 30 days', () => {
  expect(peerListingSql('pl')).toBe(
    "((pl.sold_at IS NULL OR pl.sold_at >= now() - interval '30 days') AND (pl.flagged_removed_at IS NULL OR pl.flagged_removed_at >= now() - interval '30 days'))",
  )
})

test('notJunkPriceSql bounds the column at the floor and rejects placeholder patterns', () => {
  expect(notJunkPriceSql('l.price_amount')).toBe(
    `l.price_amount >= 100 AND ${notPlaceholderPriceSql('l.price_amount')}`,
  )
})

test('notMagnitudeOutlierSql keeps a row with no median, drops it against a non-positive one, otherwise bounds it at 10x either way', () => {
  expect(notMagnitudeOutlierSql('l.price_amount', 'm.raw_median_price')).toBe(
    '(m.raw_median_price IS NULL OR (m.raw_median_price > 0 AND l.price_amount BETWEEN m.raw_median_price / 10 AND m.raw_median_price * 10))',
  )
})

test('medianCtes filters the pool to valid prices and gates both medians on the minimum sample', () => {
  const sql = medianCtes({ name: 'peer', pool: 'SELECT product_id, price_amount FROM listings' })

  expect(sql).toContain('peer_prices AS (')
  expect(sql).toContain('SELECT * FROM (SELECT product_id, price_amount FROM listings) pool')
  expect(sql).toContain(`price_amount IS NOT NULL AND ${notJunkPriceSql('price_amount')}`)
  expect(sql).toContain('peer_raw AS (')
  expect(sql).toContain('GROUP BY product_id')
  expect(sql).toContain('peer AS (')
  expect(sql).toContain('CASE WHEN count(*) >= 3 THEN percentile_cont(0.5)')
  expect(sql).toContain('r.raw_median_price IS NOT NULL')
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

test('DISCOUNT_SUMMARY_LATERAL takes the product median over peer listings only, never for an excluded product', () => {
  expect(DISCOUNT_SUMMARY_LATERAL).toContain(peerListingSql('pl'))
  expect(DISCOUNT_SUMMARY_LATERAL).toContain('NOT p.price_lookup_excluded')
})
