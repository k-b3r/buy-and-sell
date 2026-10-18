import { existsSync, rmSync } from 'node:fs'
import type { PageDriver } from './types'
import { createLogger } from '../../platform/logger'
import { resolvePageState } from './page-state'

const LOG_PATH = 'data/tmp-page-state.log'

const noDelay = async () => {}

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function makeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    gotoSearch: async () => {},
    getGridHtml: async () => '<html></html>',
    openListing: async () => {},
    getDetailHtml: async () => '<html></html>',
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => '{}',
    ...overrides,
  }
}

test('resolvePageState tags the stop reason so callers can distinguish a real block from a persisted soft-wall', async () => {
  const driver = makeDriver({ refresh: async () => {} })
  const logger = createLogger(LOG_PATH)

  const hardBlock = await resolvePageState(
    { driver, logger, delay: noDelay },
    { fetchHtml: async () => `<div class="checkpoint_challenge">captcha</div>`, hasContent: () => false },
    10,
  )
  expect(hardBlock).toEqual({ status: 'stop', reason: 'hard-block' })

  const softWallPersisted = await resolvePageState(
    { driver, logger, delay: noDelay },
    { fetchHtml: async () => `<div class="login_form">log in</div>`, hasContent: () => false },
    10,
  )
  expect(softWallPersisted).toEqual({ status: 'stop', reason: 'soft-wall-persisted' })
})

test('resolvePageState waits the soft-wall timeout through the injected delay before refreshing', async () => {
  const waits: number[] = []
  const driver = makeDriver({ refresh: async () => {} })
  await resolvePageState(
    {
      driver,
      logger: createLogger(LOG_PATH),
      delay: async (ms) => {
        waits.push(ms)
      },
    },
    { fetchHtml: async () => `<div class="login_form">log in</div>`, hasContent: () => false },
    45000,
  )
  expect(waits).toEqual([45000])
})
