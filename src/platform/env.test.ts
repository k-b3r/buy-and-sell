import { isTestRun } from './env'

test('isTestRun is true only when TEST_RUN is exactly "true"', () => {
  expect(isTestRun({ TEST_RUN: 'true' })).toBe(true)
  expect(isTestRun({ TEST_RUN: 'false' })).toBe(false)
  expect(isTestRun({})).toBe(false)
})
