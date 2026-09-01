import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createWorkerControlHandler } from './workerControl'
import type { RouteResult } from '../app'

interface StatusBody {
  running: boolean
  lastRunErrored: boolean
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

// Real EventEmitter, not a plain object - the exit-tracking test cases need
// to actually fire 'exit' the same way a genuine ChildProcess would.
function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & { pid: number }
  child.pid = pid
  return child
}

function fakeDeps(overrides: {
  isAlive?: (pid: number) => boolean
  kill?: ReturnType<typeof vi.fn>
  spawn?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    isAlive: overrides.isAlive ?? (() => false),
    kill: overrides.kill ?? vi.fn(),
    spawn: overrides.spawn ?? vi.fn(() => fakeChild()),
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
  'status: no run history yet -> lastRunErrored false',
  withTmpDir(async (dir) => {
    const handle = createWorkerControlHandler(dir, fakeDeps())
    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.lastRunErrored).toBe(false)
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
    expect(result).toEqual({ statusCode: 200, body: { running: false, lastRunErrored: false } })
  }),
)

test(
  'stop: not running is a no-op, not an error',
  withTmpDir(async (dir) => {
    const kill = vi.fn()
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, kill }))
    const result = await handle({ worker: 'collect', action: 'stop' })
    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({ statusCode: 200, body: { running: false, lastRunErrored: false } })
  }),
)

test(
  'start: spawns the right command and writes the new pid',
  withTmpDir(async (dir) => {
    const spawn = vi.fn(() => fakeChild())
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    const result = await handle({ worker: 'collect', action: 'start' })

    expect(spawn).toHaveBeenCalledWith('npx', ['tsx', 'src/workers/collect/index.ts', '--cycle'], expect.any(Object))
    expect(result).toEqual({ statusCode: 200, body: { running: true, lastRunErrored: false } })
  }),
)

test(
  'start: other workers get no extra args (only collect runs --cycle)',
  withTmpDir(async (dir) => {
    const spawn = vi.fn(() => fakeChild())
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    await handle({ worker: 'check-listings', action: 'start' })

    expect(spawn).toHaveBeenCalledWith('npx', ['tsx', 'src/workers/check-listings/index.ts'], expect.any(Object))
  }),
)

test(
  'start: already running returns 409, does not spawn again',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.pid'), '999')
    const spawn = vi.fn(() => fakeChild())
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: (pid) => pid === 999, spawn }))
    const result = await handle({ worker: 'collect', action: 'start' })

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({ statusCode: 409, body: { error: 'collect is already running' } })
  }),
)

test(
  'start: clears the worker\'s existing log file',
  withTmpDir(async (dir) => {
    writeFileSync(path.join(dir, 'collector.log'), 'old run output\nmore old output\n')
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false }))
    await handle({ worker: 'collect', action: 'start' })

    expect(readFileSync(path.join(dir, 'collector.log'), 'utf8')).toBe('')
  }),
)

test(
  'start: creates an empty log file if there was none before',
  withTmpDir(async (dir) => {
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false }))
    await handle({ worker: 'collect', action: 'start' })

    expect(readFileSync(path.join(dir, 'collector.log'), 'utf8')).toBe('')
  }),
)

test(
  'start: immediately writes the spawned pid, closing the race before the worker self-registers',
  withTmpDir(async (dir) => {
    const spawn = vi.fn(() => fakeChild())
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: (pid) => pid === 4242, spawn }))
    await handle({ worker: 'collect', action: 'start' })

    expect(readFileSync(path.join(dir, 'collector.pid'), 'utf8')).toBe('4242')

    // A second start right after, before a real worker would have had any
    // chance to self-register via its own writePidFile (confirmed live: this
    // exact gap let a second click spawn a duplicate collect process).
    const result = await handle({ worker: 'collect', action: 'start' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ statusCode: 409, body: { error: 'collect is already running' } })
  }),
)

test(
  'a crashed run (non-zero exit code, no signal) marks lastRunErrored true',
  withTmpDir(async (dir) => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    await handle({ worker: 'collect', action: 'start' })

    child.emit('exit', 1, null)

    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.lastRunErrored).toBe(true)
  }),
)

test(
  'a clean exit (code 0) resets lastRunErrored to false',
  withTmpDir(async (dir) => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    await handle({ worker: 'collect', action: 'start' })

    child.emit('exit', 0, null)

    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.lastRunErrored).toBe(false)
  }),
)

test(
  'a signal-terminated exit (external kill, no prior Stop call) is not treated as an error',
  withTmpDir(async (dir) => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    await handle({ worker: 'collect', action: 'start' })

    child.emit('exit', null, 'SIGTERM')

    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(result.lastRunErrored).toBe(false)
  }),
)

test(
  'a Stop-triggered exit is never treated as an error, even if the wrapper reports it as a plain non-zero code (confirmed live: npm relays a killed child as its own exit code, not a signal)',
  withTmpDir(async (dir) => {
    const child = fakeChild()
    const kill = vi.fn(() => {
      // Mirrors the real, confirmed-live npm/npx quirk: the wrapper process
      // this route actually listens on doesn't report the leaf's SIGTERM as
      // its own signal - it just exits with a plain non-zero code.
      child.emit('exit', 1, null)
    })
    const handle = createWorkerControlHandler(
      dir,
      fakeDeps({ isAlive: (pid) => pid === child.pid, kill, spawn: vi.fn(() => child) }),
    )

    await handle({ worker: 'collect', action: 'start' })
    const result = asBody<StatusBody>(await handle({ worker: 'collect', action: 'stop' }))
    expect(result.lastRunErrored).toBe(false)

    const status = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(status.lastRunErrored).toBe(false)
  }),
)

test(
  'lastRunErrored stays true across a subsequent Start - only clears once that new run itself exits',
  withTmpDir(async (dir) => {
    const firstChild = fakeChild(4242)
    const secondChild = fakeChild(5555)
    const spawn = vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))

    await handle({ worker: 'collect', action: 'start' })
    firstChild.emit('exit', 1, null)

    // Starting again must NOT silently clear the red/error state - it should
    // stay true until THIS new run also concludes, one way or the other.
    const startResult = asBody<StatusBody>(await handle({ worker: 'collect', action: 'start' }))
    expect(startResult.lastRunErrored).toBe(true)

    const midRunStatus = asBody<StatusBody>(await handle({ worker: 'collect', action: 'status' }))
    expect(midRunStatus.lastRunErrored).toBe(true)
  }),
)

test(
  'start: redirects stderr to the log file instead of discarding it (stdout stays ignored - createLogger already writes there too)',
  withTmpDir(async (dir) => {
    const spawn = vi.fn(() => fakeChild())
    const handle = createWorkerControlHandler(dir, fakeDeps({ isAlive: () => false, spawn }))
    await handle({ worker: 'collect', action: 'start' })

    const options = spawn.mock.calls[0][2] as { stdio: unknown[] }
    expect(options.stdio[0]).toBe('ignore')
    expect(options.stdio[1]).toBe('ignore')
    expect(typeof options.stdio[2]).toBe('number')
  }),
)
