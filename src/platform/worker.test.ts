import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runWorker, runWorkerProcess, writePidFile } from './worker'
import type { WorkerDeps, WorkerConfig } from './worker'

class StopLoop extends Error {}

interface Harness {
  deps: WorkerDeps
  logs: string[]
  events: string[]
  delays: number[]
  settingQueries: unknown[][]
}

// A fake pool answering loadSettings from `settings`, and a delay that ends
// the otherwise endless lap loop once `laps` laps have slept.
function harness(settings: Record<string, number> = {}, laps = 1): Harness {
  const logs: string[] = []
  const events: string[] = []
  const delays: number[] = []
  const settingQueries: unknown[][] = []
  const deps: WorkerDeps = {
    createLogger: (logPath) => {
      events.push(`logger ${logPath}`)
      return {
        info: (msg) => logs.push(`INFO ${msg}`),
        warn: (msg) => logs.push(`WARN ${msg}`),
        error: (msg) => logs.push(`ERROR ${msg}`),
      }
    },
    writePidFile: (pidPath) => events.push(`pid ${pidPath}`),
    createDbPool: (url) => {
      events.push(`pool ${url}`)
      return {
        query: async (_sql, params) => {
          settingQueries.push(params)
          const keys = params[0] as string[]
          return { rows: keys.filter((k) => k in settings).map((key) => ({ key, value: settings[key] })) }
        },
        end: async () => {
          events.push('pool end')
        },
      }
    },
    delay: async (ms) => {
      delays.push(ms)
      if (delays.length >= laps) throw new StopLoop()
    },
  }
  return { deps, logs, events, delays, settingQueries }
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'demo',
    databaseUrl: 'postgres://demo',
    testRun: false,
    settingKeys: ['demo.batch_size', 'demo.loop_delay_ms'],
    loopDelayKey: 'demo.loop_delay_ms',
    setup: () => async () => ({ dryRun: 'would do demo work', run: async () => {} }),
    ...overrides,
  }
}

test('runWorker writes the log and pid files under data/ named after the worker, then opens the pool', async () => {
  const h = harness()
  await expect(runWorker(config(), h.deps)).rejects.toBeInstanceOf(StopLoop)
  expect(h.events.slice(0, 3)).toEqual(['logger data/demo.log', 'pid data/demo.pid', 'pool postgres://demo'])
})

test('runWorker logs the same lap lines the workers always have, sleeping the loop delay setting between laps', async () => {
  const h = harness({ 'demo.loop_delay_ms': 1234 }, 2)
  await expect(runWorker(config(), h.deps)).rejects.toBeInstanceOf(StopLoop)
  expect(h.logs).toEqual([
    'INFO looping indefinitely — Ctrl+C to stop',
    'INFO lap 1 starting',
    'INFO lap 1 complete, sleeping 1234ms',
    'INFO lap 2 starting',
    'INFO lap 2 complete, sleeping 1234ms',
  ])
  expect(h.delays).toEqual([1234, 1234])
})

test('runWorker reloads settings fresh every lap and hands them to the lap with its number', async () => {
  const h = harness({ 'demo.batch_size': 7 }, 2)
  const seen: { lap: number; settings: Record<string, number> }[] = []
  await expect(
    runWorker(
      config({
        setup: () => async (ctx) => {
          seen.push(ctx)
          return { dryRun: '', run: async () => {} }
        },
      }),
      h.deps,
    ),
  ).rejects.toBeInstanceOf(StopLoop)
  expect(h.settingQueries).toEqual([
    [['demo.batch_size', 'demo.loop_delay_ms']],
    [['demo.batch_size', 'demo.loop_delay_ms']],
  ])
  expect(seen.map((s) => s.lap)).toEqual([1, 2])
  expect(seen[0].settings).toEqual({ 'demo.batch_size': 7, 'demo.loop_delay_ms': undefined })
})

test('runWorker loads the loop delay key even when settingKeys leaves it out', async () => {
  const h = harness()
  await expect(runWorker(config({ settingKeys: ['demo.batch_size'] }), h.deps)).rejects.toBeInstanceOf(StopLoop)
  expect(h.settingQueries).toEqual([[['demo.batch_size', 'demo.loop_delay_ms']]])
})

test('runWorker runs setup once with the logger and pool, logging before the loop banner', async () => {
  const h = harness({}, 2)
  let setups = 0
  await expect(
    runWorker(
      config({
        setup: ({ logger, db }) => {
          setups++
          logger.info('clients ready')
          expect(typeof db.query).toBe('function')
          return async () => ({ dryRun: '', run: async () => {} })
        },
      }),
      h.deps,
    ),
  ).rejects.toBeInstanceOf(StopLoop)
  expect(setups).toBe(1)
  expect(h.logs.slice(0, 2)).toEqual(['INFO clients ready', 'INFO looping indefinitely — Ctrl+C to stop'])
})

test('runWorker runs the lap plan for real when not a test run', async () => {
  const h = harness({ 'demo.loop_delay_ms': 10 })
  await expect(
    runWorker(
      config({
        setup:
          ({ logger }) =>
          async () => ({ dryRun: 'would do demo work', run: async () => logger.info('did demo work') }),
      }),
      h.deps,
    ),
  ).rejects.toBeInstanceOf(StopLoop)
  expect(h.logs).toContain('INFO did demo work')
  expect(h.logs.some((l) => l.includes('TEST_RUN'))).toBe(false)
})

test('runWorker on a test run logs the dry-run line instead of running the lap plan', async () => {
  const h = harness({ 'demo.loop_delay_ms': 10 })
  const run = vi.fn(async () => {})
  await expect(
    runWorker(
      config({
        testRun: true,
        setup:
          ({ logger }) =>
          async () => {
            logger.info('3 pending this lap')
            return { dryRun: 'would do demo work on 3 items', run }
          },
      }),
      h.deps,
    ),
  ).rejects.toBeInstanceOf(StopLoop)
  expect(run).not.toHaveBeenCalled()
  expect(h.logs).toEqual([
    'INFO looping indefinitely — Ctrl+C to stop',
    'INFO lap 1 starting',
    'INFO 3 pending this lap',
    'INFO TEST_RUN: would do demo work on 3 items',
    'INFO lap 1 complete, sleeping 10ms',
  ])
})

test('runWorker ends the pool when a lap throws, and rethrows', async () => {
  const h = harness()
  const boom = new Error('boom')
  await expect(
    runWorker(
      config({
        setup: () => async () => ({
          dryRun: '',
          run: async () => {
            throw boom
          },
        }),
      }),
      h.deps,
    ),
  ).rejects.toBe(boom)
  expect(h.events.at(-1)).toBe('pool end')
  expect(h.delays).toEqual([])
})

test('runWorkerProcess gives the body a logger and pool, and ends the pool once the body returns', async () => {
  const h = harness()
  await runWorkerProcess(
    'collector',
    'postgres://demo',
    async ({ logger }) => {
      logger.info('body ran')
    },
    h.deps,
  )
  expect(h.events).toEqual(['logger data/collector.log', 'pid data/collector.pid', 'pool postgres://demo', 'pool end'])
  expect(h.logs).toEqual(['INFO body ran'])
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
