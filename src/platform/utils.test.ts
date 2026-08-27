import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isTestRun, writePidFile } from './utils'

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

test('writePidFile writes the current process id as a string', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pidfile-test-'))
  try {
    const file = path.join(dir, 'worker.pid')
    writePidFile(file)
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
