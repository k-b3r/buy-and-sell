import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkerControlHandler } from './workerControl'
import type { RouteResult } from '../app'

interface StatusBody {
  running: boolean
}

function asBody<T>(result: RouteResult): T {
  return result.body as T
}

function withTmpDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'worker-control-test-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function fakeDeps(overrides: {
  isAlive?: (pid: number) => boolean
  kill?: ReturnType<typeof vi.fn>
  spawn?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    isAlive: overrides.isAlive ?? (() => false),
    kill: overrides.kill ?? vi.fn(),
    spawn: overrides.spawn ?? vi.fn(() => ({ pid: 4242 })),
  }
}

test(
  'unknown worker key returns 400',
  withTmpDir(async (dir) => {
    const handle = createWorkerControlHandler(dir, fakeDeps())
    expect(await handle({ worker: 'not-a-worker', action: 'status' })).toEqual({
      statusCode: 400,
      body: { error: 'unknown "worker"' },
    })
  }),
)

test(
  'invalid action returns 400',
  withTmpDir(async (dir) => {
    const handle = createWorkerControlHandler(dir, fakeDeps())
    expect(await handle({ worker: 'collect', action: 'dance' })).toEqual({
      statusCode: 400,
      body: { error: 'unknown "action"' },
    })
  }),
)

test(
  'status: no pid file -> not running',
  withTmpDir(async (dir) => {
    const handle = createWorkerControlHandler(dir, fakeDeps())
    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.running).toBe(false)
  }),
)

test(
  'status: pid file with a live pid -> running',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.pid'), '999')
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: (pid) => pid === 999 }))
    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.running).toBe(true)
  }),
)

test(
  'status: pid file with a stale (dead) pid -> not running',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.pid'), '999')
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false }))
    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.running).toBe(false)
  }),
)

test(
  'stop: sends SIGTERM to the live pid',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.pid'), '999')
    const kill = vi.fn()
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: (pid) => pid === 999, kill }))
    const result = await handle({ worker: 'collect', action: 'stop' })
    expect(kill).toHaveBeenCalledWith(999, 'SIGTERM')
    expect(result).toEqual({ statusCode: 200, body: { running: false } })
  }),
)

test(
  'stop: not running is a no-op, not an error',
  withTmpDir(async (dir) => {
    const kill = vi.fn()
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, kill }))
    const result = await handle({ worker: 'collect', action: 'stop' })
    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({ statusCode: 200, body: { running: false } })
  }),
)

test(
  'start: spawns the right command and writes the new pid',
  withTmpDir(async (dir) => {
    const spawn = vi.fn(() => ({ pid: 4242 }))
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    const result = await handle({ worker: 'collect', action: 'start' })

    expect(spawn).toHaveBeenCalledWith('npx', ['tsx', 'src/workers/collect/index.ts'], expect.any(Object))
    expect(result).toEqual({ statusCode: 200, body: { running: true } })
  }),
)

test(
  'start: already running returns 409, does not spawn again',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.pid'), '999')
    const spawn = vi.fn(() => ({ pid: 4242 }))
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: (pid) => pid === 999, spawn }))
    const result = await handle({ worker: 'collect', action: 'start' })

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({ statusCode: 409, body: { error: 'collect is already running' } })
  }),
)
