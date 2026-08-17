import { readFileSync, rmSync, existsSync } from 'node:fs'
import { createLogger } from '../src/logger'

const LOG_PATH = 'test/tmp-logger.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

test('info/warn/error write human-readable timestamped lines to file', () => {
  const logger = createLogger(LOG_PATH)
  logger.info('starting run')
  logger.warn('soft wall detected')
  logger.error('hard block, stopping')

  const contents = readFileSync(LOG_PATH, 'utf-8')
  const lines = contents.trim().split('\n')

  expect(lines).toHaveLength(3)
  expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\] \[INFO\] starting run$/)
  expect(lines[1]).toMatch(/\[WARN\] soft wall detected$/)
  expect(lines[2]).toMatch(/\[ERROR\] hard block, stopping$/)
})
