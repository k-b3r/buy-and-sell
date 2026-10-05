import type { Logger } from '../../platform/logger'
import type { DelayFn } from '../../platform/delay'
import { summarizeError } from '../../platform/errors'
import { QuotaExhaustedError, isQuotaError } from './error-classification'

// A request's transient failures used up its attempts. The message is the
// last failure, summarized to one line for the caller's outcome log.
export class RetriesExhaustedError extends Error {
  override name = 'RetriesExhaustedError'
}

export interface RetryOptions {
  // Names the provider in log lines ("Groq request failed, ...").
  provider: string
  // Log prefix identifying the batch ("batch starting at 40"); none if omitted.
  label?: string
  maxAttempts: number
  // Wait after a failed attempt: fixed, or doubled per attempt (base, 2x, 4x...).
  retryDelayMs: number
  backoff?: 'fixed' | 'exponential'
  delay: DelayFn
  logger: Logger
}

// Bounded retry for one request, classified by the shared rule: a quota error
// unwinds at once as QuotaExhaustedError (retrying cannot refill a quota),
// anything else is retried up to maxAttempts, then thrown as
// RetriesExhaustedError. Those two are the only errors that escape, so the
// caller decides only the outcome (stop the run, fall back to another
// provider), never the loop.
export async function withRetry<T>(request: () => Promise<T>, options: RetryOptions): Promise<T> {
  const prefix = options.label ? `${options.label}: ` : ''
  for (let attempt = 1; ; attempt++) {
    try {
      return await request()
    } catch (err) {
      const message = summarizeError(err)
      if (err instanceof QuotaExhaustedError) throw err
      if (isQuotaError(err)) throw new QuotaExhaustedError(message, { cause: err })
      if (attempt >= options.maxAttempts) throw new RetriesExhaustedError(message, { cause: err })
      const wait = options.backoff === 'exponential' ? options.retryDelayMs * 2 ** (attempt - 1) : options.retryDelayMs
      options.logger.warn(
        `${prefix}${options.provider} request failed, attempt ${attempt}/${options.maxAttempts} (${message}), retrying in ${wait}ms`,
      )
      await options.delay(wait)
    }
  }
}

export interface RetryAndSplitOptions<Item, Raw, Result> extends Omit<RetryOptions, 'label'> {
  items: Item[]
  request: (part: Item[]) => Promise<Raw>
  // Runs once per part that got a response (not retried); offset is the
  // part's index within items, for the caller's own log lines.
  onResponse: (part: Item[], response: Raw, offset: number) => Promise<Result[]> | Result[]
  itemId: (item: Item) => string | number
  label?: (offset: number) => string
}

// withRetry, then degrade instead of giving up: a batch whose retries run out
// is halved (larger half first) and each half retried with a fresh budget, down
// to a single item, which is then skipped and logged. Confirmed live 2026-08-28:
// a smaller array gives the model less room to lose the response shape, so
// halving is a real mitigation. A skipped item is never marked processed, so it
// stays a candidate for the next run. A quota error unwinds the whole call.
export async function withRetryAndSplit<Item, Raw, Result>(
  options: RetryAndSplitOptions<Item, Raw, Result>,
): Promise<Result[]> {
  return attemptPart(options, options.items, 0)
}

async function attemptPart<Item, Raw, Result>(
  options: RetryAndSplitOptions<Item, Raw, Result>,
  part: Item[],
  offset: number,
): Promise<Result[]> {
  if (part.length === 0) return []
  const label = options.label?.(offset)
  let response: Raw
  try {
    response = await withRetry(() => options.request(part), { ...options, label })
  } catch (err) {
    if (!(err instanceof RetriesExhaustedError)) throw err
    const failed = `${options.provider} request failed after ${options.maxAttempts} attempts`
    if (part.length === 1) {
      options.logger.error(`item ${options.itemId(part[0])}: ${failed} even at batch size 1 (${err.message}), skipping`)
      return []
    }
    const mid = Math.ceil(part.length / 2)
    options.logger.error(
      `${label ? `${label}: ` : ''}${failed} at batch size ${part.length} (${err.message}), splitting into ${mid} + ${part.length - mid} and retrying`,
    )
    const first = await attemptPart(options, part.slice(0, mid), offset)
    const second = await attemptPart(options, part.slice(mid), offset + mid)
    return [...first, ...second]
  }
  return options.onResponse(part, response, offset)
}
