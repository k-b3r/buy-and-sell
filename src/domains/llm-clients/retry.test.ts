import type { Logger } from '../../platform/logger'
import { QuotaExhaustedError } from './error-classification'
import { RetriesExhaustedError, withRetry, withRetryAndSplit } from './retry'

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`INFO ${msg}`),
    warn: (msg) => lines.push(`WARN ${msg}`),
    error: (msg) => lines.push(`ERROR ${msg}`),
  }
}

function recordingDelay(): { delay: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return { waits, delay: async (ms) => void waits.push(ms) }
}

const quota = () => Object.assign(new Error('rate_limit_exceeded'), { status: 429 })
const glitch = () => Object.assign(new Error('json_validate_failed'), { status: 400 })

function failingTimes<T>(failures: number, value: T, error = glitch): () => Promise<T> {
  let calls = 0
  return async () => {
    calls += 1
    if (calls <= failures) throw error()
    return value
  }
}

const base = { provider: 'Groq', maxAttempts: 3, retryDelayMs: 3000 }

test('withRetry returns the first successful response, waiting a fixed delay after each failed attempt', async () => {
  const logger = recordingLogger()
  const { delay, waits } = recordingDelay()
  const out = await withRetry(failingTimes(2, 'ok'), { ...base, label: 'batch starting at 0', delay, logger })
  expect(out).toBe('ok')
  expect(waits).toEqual([3000, 3000])
  expect(logger.lines).toEqual([
    'WARN batch starting at 0: Groq request failed, attempt 1/3 (json_validate_failed), retrying in 3000ms',
    'WARN batch starting at 0: Groq request failed, attempt 2/3 (json_validate_failed), retrying in 3000ms',
  ])
})

test('withRetry doubles the delay after each failed attempt when backoff is exponential', async () => {
  const { delay, waits } = recordingDelay()
  await withRetry(failingTimes(3, 'ok'), {
    ...base,
    maxAttempts: 5,
    retryDelayMs: 30000,
    backoff: 'exponential',
    delay,
    logger: recordingLogger(),
  })
  expect(waits).toEqual([30000, 60000, 120000])
})

test('withRetry throws RetriesExhaustedError after maxAttempts transient failures, without a final wait', async () => {
  const logger = recordingLogger()
  const { delay, waits } = recordingDelay()
  const request = vi.fn(failingTimes(99, 'never'))
  const err = await withRetry(request, { ...base, delay, logger }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(RetriesExhaustedError)
  expect((err as RetriesExhaustedError).message).toBe('json_validate_failed')
  expect(request).toHaveBeenCalledTimes(3)
  expect(waits).toEqual([3000, 3000])
  expect(logger.lines[0]).toBe('WARN Groq request failed, attempt 1/3 (json_validate_failed), retrying in 3000ms')
})

test('withRetry unwinds a quota error as QuotaExhaustedError on the first hit, without retrying', async () => {
  const request = vi.fn(failingTimes(99, 'never', quota))
  const err = await withRetry(request, { ...base, delay: async () => {}, logger: recordingLogger() }).catch(
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(QuotaExhaustedError)
  expect((err as QuotaExhaustedError).message).toBe('rate_limit_exceeded')
  expect((err as QuotaExhaustedError).cause).toMatchObject({ status: 429 })
  expect(request).toHaveBeenCalledTimes(1)
})

interface Item {
  id: number
}
const items = (...ids: number[]): Item[] => ids.map((id) => ({ id }))

test('withRetryAndSplit hands each successful response to onResponse with its offset', async () => {
  const seen: [number[], string, number][] = []
  const out = await withRetryAndSplit({
    ...base,
    items: items(1, 2),
    request: async (part) => `raw ${part.length}`,
    onResponse: (part, raw, offset) => {
      seen.push([part.map((i) => i.id), raw, offset])
      return part.map((i) => i.id * 10)
    },
    itemId: (item) => item.id,
    delay: async () => {},
    logger: recordingLogger(),
  })
  expect(out).toEqual([10, 20])
  expect(seen).toEqual([[[1, 2], 'raw 2', 0]])
})

test('withRetryAndSplit halves a batch that keeps failing and retries each half with a fresh budget', async () => {
  const logger = recordingLogger()
  const sizes: number[] = []
  const out = await withRetryAndSplit({
    ...base,
    label: (offset) => `batch starting at ${100 + offset}`,
    items: items(1, 2, 3, 4),
    request: async (part) => {
      sizes.push(part.length)
      if (part.length > 2) throw glitch()
      return part
    },
    onResponse: (part, raw, offset) => raw.map((i) => `${i.id}@${offset}`),
    itemId: (item) => item.id,
    delay: async () => {},
    logger,
  })
  expect(sizes).toEqual([4, 4, 4, 2, 2])
  expect(out).toEqual(['1@0', '2@0', '3@2', '4@2'])
  expect(logger.lines).toContain(
    'ERROR batch starting at 100: Groq request failed after 3 attempts at batch size 4 (json_validate_failed), splitting into 2 + 2 and retrying',
  )
})

test('withRetryAndSplit splits an odd batch with the larger half first', async () => {
  const sizes: number[] = []
  await withRetryAndSplit({
    ...base,
    maxAttempts: 1,
    items: items(1, 2, 3),
    request: async (part) => {
      sizes.push(part.length)
      if (part.length > 2) throw glitch()
      return part
    },
    onResponse: () => [],
    itemId: (item) => item.id,
    delay: async () => {},
    logger: recordingLogger(),
  })
  expect(sizes).toEqual([3, 2, 1])
})

test('withRetryAndSplit skips a single item that still fails, logging its id, and keeps the rest', async () => {
  const logger = recordingLogger()
  const out = await withRetryAndSplit({
    ...base,
    items: items(1, 2),
    request: async (part) => {
      if (part.some((i) => i.id === 2)) throw glitch()
      return part
    },
    onResponse: (part) => part.map((i) => i.id),
    itemId: (item) => item.id,
    delay: async () => {},
    logger,
  })
  expect(out).toEqual([1])
  expect(logger.lines).toContain(
    'ERROR item 2: Groq request failed after 3 attempts even at batch size 1 (json_validate_failed), skipping',
  )
})

test('withRetryAndSplit unwinds a quota error from any half instead of splitting further', async () => {
  const request = vi.fn(async (part: Item[]) => {
    if (part.length > 1) throw glitch()
    throw quota()
  })
  await expect(
    withRetryAndSplit({
      ...base,
      items: items(1, 2),
      request,
      onResponse: () => [],
      itemId: (item) => item.id,
      delay: async () => {},
      logger: recordingLogger(),
    }),
  ).rejects.toBeInstanceOf(QuotaExhaustedError)
  expect(request).toHaveBeenCalledTimes(4)
})

test('withRetryAndSplit makes no request for an empty item list', async () => {
  const request = vi.fn(async () => 'raw')
  const out = await withRetryAndSplit({
    ...base,
    items: [] as Item[],
    request,
    onResponse: () => [1],
    itemId: (item) => item.id,
    delay: async () => {},
    logger: recordingLogger(),
  })
  expect(out).toEqual([])
  expect(request).not.toHaveBeenCalled()
})
