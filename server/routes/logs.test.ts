import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLogsHandler } from './logs'
import type { RouteResult } from '../app'

interface LogsBody {
  lines: string[]
  nextOffset: number
}

function asLogsResult(result: RouteResult): { statusCode: number; body: LogsBody } {
  return result as { statusCode: number; body: LogsBody }
}

function withTmpDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'logs-test-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test(
  'unknown worker key returns 400',
  withTmpDir(async (dir) => {
    const handle = createLogsHandler(dir)
    expect(await handle({ worker: 'not-a-worker' })).toEqual({
      statusCode: 400,
      body: { error: 'unknown "worker"' },
    })
  }),
)

test(
  'missing file returns empty lines and nextOffset 0',
  withTmpDir(async (dir) => {
    const handle = createLogsHandler(dir)
    expect(await handle({ worker: 'collect' })).toEqual({
      statusCode: 200,
      body: { lines: [], nextOffset: 0 },
    })
  }),
)

test(
  'offset omitted returns last 200 lines and full file size as nextOffset',
  withTmpDir(async (dir) => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    const content = lines.join('\n') + '\n'
    writeFileSync(path.join(dir, 'collector.log'), content)

    const handle = createLogsHandler(dir)
    const result = asLogsResult(await handle({ worker: 'collect' }))

    expect(result.statusCode).toBe(200)
    expect(result.body.lines).toHaveLength(200)
    expect(result.body.lines[0]).toBe('line 50')
    expect(result.body.lines[199]).toBe('line 249')
    expect(result.body.nextOffset).toBe(Buffer.byteLength(content))
  }),
)

test(
  'offset given returns only the delta since offset',
  withTmpDir(async (dir) => {
    const filePath = path.join(dir, 'collector.log')
    writeFileSync(filePath, 'line 0\nline 1\n')
    const handle = createLogsHandler(dir)

    const first = asLogsResult(await handle({ worker: 'collect' }))
    expect(first.body.lines).toEqual(['line 0', 'line 1'])

    writeFileSync(filePath, 'line 2\n', { flag: 'a' })
    const second = asLogsResult(await handle({ worker: 'collect', offset: first.body.nextOffset }))

    expect(second.body.lines).toEqual(['line 2'])
    expect(second.body.nextOffset).toBe(Buffer.byteLength('line 0\nline 1\nline 2\n'))
  }),
)

test(
  'offset past current file size resets to a full tail',
  withTmpDir(async (dir) => {
    const filePath = path.join(dir, 'collector.log')
    writeFileSync(filePath, 'line 0\nline 1\n')
    const handle = createLogsHandler(dir)

    const result = asLogsResult(await handle({ worker: 'collect', offset: 999999 }))
    expect(result.body.lines).toEqual(['line 0', 'line 1'])
  }),
)
