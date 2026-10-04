import { realDelay } from './delay'

afterEach(() => {
  vi.useRealTimers()
})

test('realDelay resolves only once the given number of milliseconds has passed', async () => {
  vi.useFakeTimers()
  let resolved = false
  const pending = realDelay(1000).then(() => {
    resolved = true
  })
  await vi.advanceTimersByTimeAsync(999)
  expect(resolved).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(resolved).toBe(true)
})
