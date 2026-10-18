import { expect, test } from 'vitest'
import { LOOKUP_OUTCOME_REASONS, PRICE_EXCLUSION_REASONS } from './exclusion-reasons'

test('retail_not_found is the only lookup-outcome reason still written, so including a product retries just that one', () => {
  const stillWritten = LOOKUP_OUTCOME_REASONS.filter((reason) =>
    (PRICE_EXCLUSION_REASONS as readonly string[]).includes(reason),
  )

  expect(stillWritten).toEqual(['retail_not_found'])
})

test('lookup-outcome reasons keep the retired exa and claude reasons so historical rows still count as retryable', () => {
  expect(LOOKUP_OUTCOME_REASONS).toEqual(
    expect.arrayContaining(['exa_no_result', 'exa_wide_spread', 'exa_low_confidence', 'claude_no_result']),
  )
})

test('judgment reasons such as too_generic and manual_review are not lookup outcomes', () => {
  expect(LOOKUP_OUTCOME_REASONS as readonly string[]).not.toContain('too_generic')
  expect(LOOKUP_OUTCOME_REASONS as readonly string[]).not.toContain('manual_review')
})
