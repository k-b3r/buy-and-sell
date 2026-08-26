import { createRefreshPacer } from '../refreshPacer'
import { createRefreshLock } from '../refreshLock'

test('acquires immediately when the lock is free and there is no prior action', async () => {
  const lock = createRefreshLock()
  const pacer = createRefreshPacer(lock, () => 0, async () => {})

  const got = await pacer.waitForTurn()

  expect(got).toBe(true)
  expect(lock.isBusy()).toBe(true)
})

test('waits for the lock to free before acquiring', async () => {
  const lock = createRefreshLock()
  lock.acquire()
  const delays: number[] = []
  let time = 0
  const now = () => time
  const delay = async (ms: number) => {
    delays.push(ms)
    time += ms
    if (delays.length === 2) lock.release() // free it after a couple of polls
  }
  const pacer = createRefreshPacer(lock, now, delay)

  const got = await pacer.waitForTurn()

  expect(got).toBe(true)
  expect(delays.length).toBeGreaterThanOrEqual(2)
})

test('gives up and returns false if the lock never frees within the max wait', async () => {
  const lock = createRefreshLock()
  lock.acquire() // never released
  let time = 0
  const now = () => time
  const delay = async (ms: number) => {
    time += ms
  }
  const pacer = createRefreshPacer(lock, now, delay)

  const got = await pacer.waitForTurn()

  expect(got).toBe(false)
})

test('enforces a minimum pacing gap since the last recorded action', async () => {
  const lock = createRefreshLock()
  let time = 0
  const now = () => time
  const delays: number[] = []
  const delay = async (ms: number) => {
    delays.push(ms)
    time += ms
  }
  const pacer = createRefreshPacer(lock, now, delay)

  await pacer.waitForTurn()
  pacer.recordActionComplete()
  lock.release()
  time += 500 // well under the 4000-10000ms pacing window

  await pacer.waitForTurn()

  expect(delays.length).toBeGreaterThan(0)
  expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(3500) // ~4000 - 500 already elapsed
})

test('does not pace-delay when the gap since the last action already exceeds the window', async () => {
  const lock = createRefreshLock()
  let time = 0
  const now = () => time
  const delays: number[] = []
  const delay = async (ms: number) => {
    delays.push(ms)
    time += ms
  }
  const pacer = createRefreshPacer(lock, now, delay)

  await pacer.waitForTurn()
  pacer.recordActionComplete()
  lock.release()
  time += 20000 // well over the pacing window already

  await pacer.waitForTurn()

  expect(delays).toEqual([]) // no pacing wait needed, plenty of time already passed
})

test('release() releases the underlying lock', async () => {
  const lock = createRefreshLock()
  const pacer = createRefreshPacer(lock, () => 0, async () => {})

  await pacer.waitForTurn()
  expect(lock.isBusy()).toBe(true)

  pacer.release()
  expect(lock.isBusy()).toBe(false)
})

test('first-ever call has no prior action to pace against', async () => {
  const lock = createRefreshLock()
  const delays: number[] = []
  const pacer = createRefreshPacer(lock, () => 0, async (ms) => {
    delays.push(ms)
  })

  await pacer.waitForTurn()

  expect(delays).toEqual([])
})
