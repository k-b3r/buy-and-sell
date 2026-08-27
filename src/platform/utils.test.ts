import { isTestRun } from './utils'

test('isTestRun is true only when TEST_RUN is exactly "true"', () => {
  const original = process.env.TEST_RUN

  process.env.TEST_RUN = 'true'
  expect(isTestRun()).toBe(true)

  process.env.TEST_RUN = 'false'
  expect(isTestRun()).toBe(false)

  delete process.env.TEST_RUN
  expect(isTestRun()).toBe(false)

  if (original === undefined) delete process.env.TEST_RUN
  else process.env.TEST_RUN = original
})
