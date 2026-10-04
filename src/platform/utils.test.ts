import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writePidFile } from './utils'

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
