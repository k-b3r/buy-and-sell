import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryAcquireBrowserLock, releaseBrowserLock, acquireBrowserLock } from './browserLock'

function lockPath(): string {
  return join(tmpdir(), `browser-lock-test-${Math.random().toString(36).slice(2)}.lock`)
}

test('acquires a lock that does not exist yet', () => {
  const path = lockPath()
  const acquired = tryAcquireBrowserLock(path, { pid: 111, isAlive: () => true })
  expect(acquired).toBe(true)
  expect(existsSync(path)).toBe(true)
  rmSync(path)
})

test('refuses to acquire a lock held by a live pid', () => {
  const path = lockPath()
  tryAcquireBrowserLock(path, { pid: 111, isAlive: () => true })

  const acquired = tryAcquireBrowserLock(path, { pid: 222, isAlive: () => true })
  expect(acquired).toBe(false)
  rmSync(path)
})

test('reclaims a lock left behind by a dead pid', () => {
  const path = lockPath()
  tryAcquireBrowserLock(path, { pid: 111, isAlive: () => false })

  const acquired = tryAcquireBrowserLock(path, { pid: 222, isAlive: () => false })
  expect(acquired).toBe(true)
  rmSync(path)
})

test('release removes a lock held by the calling pid', () => {
  const path = lockPath()
  tryAcquireBrowserLock(path, { pid: 111, isAlive: () => true })

  releaseBrowserLock(path, { pid: 111, isAlive: () => true })
  expect(existsSync(path)).toBe(false)
})

test('release does not touch a lock held by a different pid', () => {
  const path = lockPath()
  tryAcquireBrowserLock(path, { pid: 111, isAlive: () => true })

  releaseBrowserLock(path, { pid: 222, isAlive: () => true })
  expect(existsSync(path)).toBe(true)
  rmSync(path)
})

test('release on a missing lock file is a no-op', () => {
  const path = lockPath()
  expect(() => releaseBrowserLock(path, { pid: 111, isAlive: () => true })).not.toThrow()
})

test('acquireBrowserLock waits and retries until the holder releases', async () => {
  const path = lockPath()
  tryAcquireBrowserLock(path, { pid: 111, isAlive: () => true })

  const logs: string[] = []
  const logger = { info: (msg: string) => logs.push(msg) }
  const delays: number[] = []
  let attempt = 0
  const fakeDelay = async (ms: number) => {
    delays.push(ms)
    attempt++
    if (attempt === 1) releaseBrowserLock(path, { pid: 111, isAlive: () => true })
  }

  await acquireBrowserLock(path, logger, { deps: { pid: 222, isAlive: () => true }, pollMs: 50, delay: fakeDelay })

  expect(existsSync(path)).toBe(true)
  expect(delays).toEqual([50])
  expect(logs.some((l) => l.includes('waiting'))).toBe(true)
  rmSync(path)
})

test('acquireBrowserLock returns immediately if nothing holds the lock', async () => {
  const path = lockPath()
  const logger = { info: () => {} }
  let delayCalls = 0

  await acquireBrowserLock(path, logger, {
    deps: { pid: 111, isAlive: () => true },
    pollMs: 50,
    delay: async () => {
      delayCalls++
    },
  })

  expect(delayCalls).toBe(0)
  expect(existsSync(path)).toBe(true)
  rmSync(path)
})
