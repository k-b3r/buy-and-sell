import { runCollectLaps } from './laps'
import type { CollectLapsDeps } from './laps'
import type { PageDriver } from '../../modules/collection'

class StopLoop extends Error {}

interface Harness {
  deps: CollectLapsDeps
  logs: string[]
  events: string[]
  delays: number[]
}

// Fake db answers loadSettings from `settings` and the keyword table from
// `keywords`; the delay ends the endless --cycle loop after `maxDelays` sleeps.
function harness(
  opts: {
    settings?: Record<string, number>
    keywords?: string[]
    maxDelays?: number
    collect?: (query: string, attempt: number) => Promise<void>
  } = {},
): Harness {
  const logs: string[] = []
  const events: string[] = []
  const delays: number[] = []
  const attempts = new Map<string, number>()
  let browsers = 0
  const deps: CollectLapsDeps = {
    db: {
      query: async (sql, params) => {
        if (sql.includes('FROM settings')) {
          const keys = params[0] as string[]
          const settings = opts.settings ?? {}
          return { rows: keys.filter((k) => k in settings).map((key) => ({ key, value: settings[key] })) }
        }
        if (sql.includes("kind = 'general'")) return { rows: (opts.keywords ?? []).map((keyword) => ({ keyword })) }
        return { rows: [] }
      },
    },
    logger: {
      info: (msg) => logs.push(`INFO ${msg}`),
      warn: (msg) => logs.push(`WARN ${msg}`),
      error: (msg) => logs.push(`ERROR ${msg}`),
    },
    delay: async (ms) => {
      delays.push(ms)
      if (opts.maxDelays !== undefined && delays.length >= opts.maxDelays) throw new StopLoop()
    },
    browserLock: {
      acquire: async () => {
        events.push('lock')
      },
      release: () => events.push('unlock'),
    },
    openBrowser: async () => {
      const id = ++browsers
      events.push(`open ${id}`)
      return {
        driver: { id } as unknown as PageDriver,
        close: async () => {
          events.push(`close ${id}`)
        },
      }
    },
    collectQuery: async (driver, { query, maxItems }) => {
      const attempt = (attempts.get(query) ?? 0) + 1
      attempts.set(query, attempt)
      events.push(`collect ${query} ${maxItems} on ${(driver as unknown as { id: number }).id}`)
      await opts.collect?.(query, attempt)
    },
  }
  return { deps, logs, events, delays }
}

test('without --cycle, runs one lap over the explicit query inside the browser lock, then returns without sleeping', async () => {
  const h = harness({ settings: { 'collect.max_items_default': 40 } })
  await runCollectLaps(h.deps, { cycle: false, testRun: false, explicitQuery: 'gaming chair' })
  expect(h.events).toEqual(['lock', 'open 1', 'collect gaming chair 40 on 1', 'close 1', 'unlock'])
  expect(h.delays).toEqual([])
  expect(h.logs).toEqual([])
})

test('an explicit maxItems overrides the collect.max_items_default setting', async () => {
  const h = harness({ settings: { 'collect.max_items_default': 40 } })
  await runCollectLaps(h.deps, { cycle: false, testRun: false, explicitQuery: 'desk', explicitMaxItems: 7 })
  expect(h.events).toContain('collect desk 7 on 1')
})

test('without an explicit query, collects every enabled keyword', async () => {
  const h = harness({ keywords: ['urgent', 'moving out'], settings: { 'collect.max_items_default': 5 } })
  await runCollectLaps(h.deps, { cycle: false, testRun: false })
  expect(h.events).toEqual([
    'lock',
    'open 1',
    'collect urgent 5 on 1',
    'collect moving out 5 on 1',
    'close 1',
    'unlock',
  ])
})

test('on a test run, logs each query it would collect and never opens a browser', async () => {
  const h = harness({ keywords: ['urgent', 'moving out'] })
  await runCollectLaps(h.deps, { cycle: false, testRun: true })
  expect(h.events).toEqual([])
  expect(h.logs).toEqual([
    'INFO TEST_RUN: marketplace will call Facebook Marketplace to collect for query "urgent"',
    'INFO TEST_RUN: marketplace will call Facebook Marketplace to collect for query "moving out"',
  ])
})

test('--cycle logs each lap and sleeps collect.loop_delay_ms with the browser closed between laps', async () => {
  const h = harness({ keywords: ['urgent'], settings: { 'collect.loop_delay_ms': 900 }, maxDelays: 2 })
  await expect(runCollectLaps(h.deps, { cycle: true, testRun: false })).rejects.toBeInstanceOf(StopLoop)
  expect(h.logs).toEqual([
    'INFO --cycle: looping indefinitely — Ctrl+C to stop',
    'INFO --cycle: lap 1 starting, 1 motivated-seller keywords',
    'INFO --cycle: lap 1 complete, sleeping 900ms with the browser closed',
    'INFO --cycle: lap 2 starting, 1 motivated-seller keywords',
    'INFO --cycle: lap 2 complete, sleeping 900ms with the browser closed',
  ])
  expect(h.delays).toEqual([900, 900])
  expect(h.events).toEqual([
    'lock',
    'open 1',
    'collect urgent 100 on 1',
    'close 1',
    'unlock',
    'lock',
    'open 2',
    'collect urgent 100 on 2',
    'close 2',
    'unlock',
  ])
})

test('--cycle on a test run paces itself at a fixed 5s without logging the lap as complete', async () => {
  const h = harness({ keywords: ['urgent'], maxDelays: 1 })
  await expect(runCollectLaps(h.deps, { cycle: true, testRun: true })).rejects.toBeInstanceOf(StopLoop)
  expect(h.delays).toEqual([5000])
  expect(h.logs).toEqual([
    'INFO --cycle: looping indefinitely — Ctrl+C to stop',
    'INFO --cycle: lap 1 starting, 1 motivated-seller keywords',
    'INFO TEST_RUN: marketplace will call Facebook Marketplace to collect for query "urgent"',
  ])
})

test('a failing query is logged, backed off and skipped, and the next keyword still runs', async () => {
  const h = harness({
    keywords: ['bad', 'good'],
    collect: async (query) => {
      if (query === 'bad') throw new Error('network blip')
    },
  })
  await runCollectLaps(h.deps, { cycle: false, testRun: false })
  expect(h.events).toContain('collect good 100 on 1')
  expect(h.delays).toEqual([5000])
  expect(h.logs[0]).toMatch(
    /^ERROR query "bad" failed \(1\/5 consecutive\), skipping to next keyword: Error: network blip/,
  )
})

test('a crashed page gets a fresh browser before the next keyword', async () => {
  const h = harness({
    keywords: ['crash', 'next'],
    collect: async (query) => {
      if (query === 'crash') throw new Error('page.goto: Page crashed')
    },
  })
  await runCollectLaps(h.deps, { cycle: false, testRun: false })
  expect(h.events).toEqual([
    'lock',
    'open 1',
    'collect crash 100 on 1',
    'close 1',
    'open 2',
    'collect next 100 on 2',
    'close 2',
    'unlock',
  ])
  expect(h.logs).toContain('WARN browser is unusable, relaunching before continuing')
})

test('five consecutive keyword failures stop the worker, still closing the browser and releasing the lock', async () => {
  const h = harness({
    keywords: ['a', 'b', 'c', 'd', 'e', 'f'],
    maxDelays: 99,
    collect: async () => {
      throw new Error('blocked')
    },
  })
  await runCollectLaps(h.deps, { cycle: true, testRun: false })
  expect(h.events.filter((e) => e.startsWith('collect'))).toHaveLength(5)
  expect(h.events.slice(-2)).toEqual(['close 1', 'unlock'])
  expect(h.delays).toEqual([5000, 10000, 15000, 20000])
  expect(h.logs.at(-1)).toMatch(/^ERROR 5 consecutive keyword failures, stopping/)
})
