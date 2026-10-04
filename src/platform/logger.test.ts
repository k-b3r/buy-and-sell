import { readFileSync, rmSync, existsSync } from 'node:fs'
import { createLogger, MAX_LOG_LINES } from './logger'

const LOG_PATH = 'data/tmp-logger.log'

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

// Regression test for a runaway worker that logged the same failure in a
// zero-delay loop and grew its log file to 16GB before anything noticed.
test('log file never grows past MAX_LOG_LINES, no matter how many lines are written', () => {
  const logger = createLogger(LOG_PATH)
  const total = MAX_LOG_LINES + 250
  for (let i = 0; i < total; i++) {
    logger.info(`line ${i}`)
  }

  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n')

  expect(lines).toHaveLength(MAX_LOG_LINES)
  // Oldest lines are dropped, not newest - the file keeps whatever was
  // logged most recently.
  expect(lines[0]).toContain(`line ${total - MAX_LOG_LINES}`)
  expect(lines[lines.length - 1]).toContain(`line ${total - 1}`)
})

test('creates the log directory when it does not exist yet (fresh clone, new host)', () => {
  const dir = 'data/tmp-logger-missing-dir'
  rmSync(dir, { recursive: true, force: true })
  try {
    createLogger(`${dir}/nested/worker.log`).info('first line')

    expect(readFileSync(`${dir}/nested/worker.log`, 'utf-8')).toMatch(/\[INFO\] first line\n$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('secret redaction', () => {
  const secret = 'fake-groq-key-for-tests'

  test.each([
    ['a known secret value', `Groq 401 for key ${secret}`, secret],
    ['an api key query param', 'GET https://api.test/v1?key=AIzaSyLeak1&q=x failed', 'AIzaSyLeak1'],
    ['URL credentials', 'proxy http://user-1:proxyPass77@p.webshare.io:80 down', 'proxyPass77'],
    ['a Bearer token', 'Authorization: Bearer eyJleakToken.abc', 'eyJleakToken.abc'],
  ])('masks %s in both the log file and the console line', (_shape, msg, leaked) => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createLogger(LOG_PATH, [secret]).error(msg)

      const fileLine = readFileSync(LOG_PATH, 'utf-8')
      const consoleLine = String(consoleLog.mock.calls[0]?.[0])
      expect(fileLine).not.toContain(leaked)
      expect(fileLine).toContain('[REDACTED]')
      expect(consoleLine).not.toContain(leaked)
      expect(consoleLine).toContain('[REDACTED]')
    } finally {
      consoleLog.mockRestore()
    }
  })

  test('a logger created without a secrets list still masks secret-shaped text', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createLogger(LOG_PATH).warn('retrying https://api.test?apikey=abc123def')

      expect(readFileSync(LOG_PATH, 'utf-8')).toMatch(/\[WARN\] retrying https:\/\/api\.test\?apikey=\[REDACTED\]\n$/)
    } finally {
      consoleLog.mockRestore()
    }
  })
})
