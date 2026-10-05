import { expect, test } from 'vitest'
import { excludeProductFromReview, getProductsNeedingReview, markProductReviewed } from './review-queue'
import type { QueryClient } from '../../platform/storage'

test('getProductsNeedingReview queries only price_lookup_review_status = needs_review, with enrichment when present', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return {
        rows: [
          {
            id: 12,
            base_model: 'Generic Wireless Earbuds',
            variant_tier: null,
            category: 'Audio',
            sub_category: 'Headphones',
            sample_photo_url: 'https://cdn/12.jpg',
            new_price_low: '1500',
            new_price_high: '2000',
            secondhand_price_low: null,
            secondhand_price_high: null,
            price_history: [
              {
                id: 501,
                kind: 'new',
                price_low: '1500',
                price_high: '2000',
                price_currency: 'PHP',
                source: 'manual_new_retail',
                condition: null,
                checked_at: new Date('2026-08-25T00:00:00.000Z'),
              },
              {
                id: 500,
                kind: 'secondhand',
                price_low: '800',
                price_high: '1200',
                price_currency: 'PHP',
                source: 'web_search',
                condition: 'Used',
                checked_at: new Date('2026-08-18T00:00:00.000Z'),
              },
            ],
            description: 'Unbranded true-wireless earbuds',
            value_drivers: 'battery life, case charging',
            has_trained_price_knowledge: false,
            trained_price_low: null,
            trained_price_high: null,
            trained_price_currency: null,
            model: 'groq-1',
            checked_at: new Date('2026-08-20T00:00:00.000Z'),
            confidence: 'low',
            is_specific_product: null,
          },
          {
            id: 13,
            base_model: 'Unknown Gadget',
            variant_tier: null,
            category: 'Other',
            sub_category: 'Other',
            sample_photo_url: null,
            new_price_low: null,
            new_price_high: null,
            secondhand_price_low: null,
            secondhand_price_high: null,
            price_history: null,
            description: null,
            value_drivers: null,
            has_trained_price_knowledge: null,
            trained_price_low: null,
            trained_price_high: null,
            trained_price_currency: null,
            model: null,
            checked_at: null,
            confidence: null,
            is_specific_product: null,
          },
        ],
      }
    },
  }

  const result = await getProductsNeedingReview(db)

  expect(capturedSql).toContain("p.price_lookup_review_status = 'needs_review'")
  expect(result).toEqual([
    {
      id: 12,
      base_model: 'Generic Wireless Earbuds',
      variant_tier: null,
      category: 'Audio',
      sub_category: 'Headphones',
      sample_photo_url: 'https://cdn/12.jpg',
      new_price_low: 1500,
      new_price_high: 2000,
      secondhand_price_low: null,
      secondhand_price_high: null,
      price_history: [
        {
          id: 501,
          kind: 'new',
          price_low: 1500,
          price_high: 2000,
          price_currency: 'PHP',
          source: 'manual_new_retail',
          condition: null,
          checked_at: '2026-08-25T00:00:00.000Z',
        },
        {
          id: 500,
          kind: 'secondhand',
          price_low: 800,
          price_high: 1200,
          price_currency: 'PHP',
          source: 'web_search',
          condition: 'Used',
          checked_at: '2026-08-18T00:00:00.000Z',
        },
      ],
      enrichment: {
        description: 'Unbranded true-wireless earbuds',
        value_drivers: 'battery life, case charging',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        trained_price_currency: null,
        model: 'groq-1',
        checked_at: '2026-08-20T00:00:00.000Z',
        confidence: 'low',
        is_specific_product: null,
      },
    },
    {
      id: 13,
      base_model: 'Unknown Gadget',
      variant_tier: null,
      category: 'Other',
      sub_category: 'Other',
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      secondhand_price_low: null,
      secondhand_price_high: null,
      price_history: [],
      enrichment: null,
    },
  ])
})

test('markProductReviewed clears price_lookup_review_status back to NULL for one product', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await markProductReviewed(db, 12)

  expect(capturedSql).toContain('price_lookup_review_status = NULL')
  expect(capturedSql).toContain('price_lookup_review_dismissed_at = now()')
  expect(capturedSql).toContain('WHERE id = $1')
  expect(capturedParams).toEqual([12])
})

test('excludeProductFromReview sets price_lookup_excluded with a reason and clears the review flag', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await excludeProductFromReview(db, 12, 'manual_review')

  expect(capturedSql).toContain('price_lookup_excluded = true')
  expect(capturedSql).toContain('price_lookup_excluded_reason = $1')
  expect(capturedSql).toContain('price_lookup_review_status = NULL')
  expect(capturedParams).toEqual(['manual_review', 12])
})
