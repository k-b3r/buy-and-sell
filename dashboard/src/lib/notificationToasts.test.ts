import { expect, test } from 'vitest'
import { selectNewToasts } from './notificationToasts'
import type { DiscountNotification } from './queries'

function notif(id: number, created_at: string): DiscountNotification {
  return {
    id,
    listing_id: String(id),
    product_id: 1,
    title: `Listing ${id}`,
    primary_photo_url: null,
    discount_percent: 40,
    reference_price: 1000,
    created_at,
    read_at: null,
    verification_reasoning: null,
  }
}

test('first call (no baseline) toasts nothing, just establishes a baseline from the newest row', () => {
  const result = selectNewToasts([notif(1, '2026-08-30T00:00:00.000Z'), notif(2, '2026-08-30T01:00:00.000Z')], null)

  expect(result.toasts).toEqual([])
  expect(result.nextBaselineIso).toBe('2026-08-30T01:00:00.000Z')
})

test('first call with an empty list toasts nothing and leaves the baseline unset', () => {
  const result = selectNewToasts([], null)

  expect(result.toasts).toEqual([])
  expect(result.nextBaselineIso).toBeNull()
})

test('a later call toasts only rows newer than the baseline, oldest first', () => {
  const baseline = '2026-08-30T01:00:00.000Z'
  const result = selectNewToasts(
    [
      notif(1, '2026-08-30T00:00:00.000Z'),
      notif(2, baseline),
      notif(3, '2026-08-30T02:00:00.000Z'),
      notif(4, '2026-08-30T01:30:00.000Z'),
    ],
    baseline,
  )

  expect(result.toasts.map((t) => t.id)).toEqual([4, 3])
  expect(result.nextBaselineIso).toBe('2026-08-30T02:00:00.000Z')
})

test('no rows newer than the baseline toasts nothing and keeps the baseline unchanged', () => {
  const baseline = '2026-08-30T02:00:00.000Z'
  const result = selectNewToasts([notif(1, '2026-08-30T00:00:00.000Z'), notif(2, baseline)], baseline)

  expect(result.toasts).toEqual([])
  expect(result.nextBaselineIso).toBe(baseline)
})
