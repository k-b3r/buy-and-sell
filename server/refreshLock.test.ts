import { createRefreshLock } from './refreshLock'

test('not busy before anything acquires it', () => {
  const lock = createRefreshLock()
  expect(lock.isBusy()).toBe(false)
})

test('acquire makes it busy', () => {
  const lock = createRefreshLock()
  lock.acquire()
  expect(lock.isBusy()).toBe(true)
})

test('release clears busy', () => {
  const lock = createRefreshLock()
  lock.acquire()
  lock.release()
  expect(lock.isBusy()).toBe(false)
})
