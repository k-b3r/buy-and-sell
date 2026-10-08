import { expect, test } from 'vitest'
import { exclusionLabel, includeExplanation, isRetryReason } from './exclusionReasons'

test('exclusionLabel gives readable copy for current and retired reasons, and passes unknown ones through', () => {
  expect(exclusionLabel('groq_generic')).toBe('AI judged it not a specific product')
  expect(exclusionLabel('exa_no_result')).toBe('No price found (old Exa search)')
  expect(exclusionLabel('some_new_reason')).toBe('some_new_reason')
})

test('isRetryReason is true only for failed price searches', () => {
  expect(isRetryReason('retail_not_found')).toBe(true)
  expect(isRetryReason('claude_no_result')).toBe(true)
  expect(isRetryReason('groq_generic')).toBe(false)
  expect(isRetryReason('manual_review')).toBe(false)
})

test('includeExplanation tells a retry apart from an override', () => {
  expect(includeExplanation('retail_not_found')).toMatch(/try this product again/)
  expect(includeExplanation('real_estate')).toMatch(/no longer exclude it/)
})
