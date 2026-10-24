import { summarizeError } from '../errors'
import { QuotaExhaustedError } from './error-classification'
import type { JsonClient } from './gateway'
import { RetriesExhaustedError, withRetry } from './retry'
import type { RetryOptions } from './retry'

// One JSON request to a model, with the retry loop and the failure
// classification the callers all share: a quota error stops at once, anything
// else is retried and then reported as exhausted. What the caller does about it
// - stop the run, try another provider, skip the batch - stays with the caller.
//
// Before this existed, four call sites repeated the same try/catch around
// withRetry, each rewriting the quota/exhausted branch and its log line.
export type CallJsonOutcome =
  { ok: true; raw: unknown } | { ok: false; reason: 'quota' | 'exhausted'; message: string; attempts: number }

export async function callJson(
  client: JsonClient,
  prompt: string,
  schema: object,
  options: RetryOptions,
): Promise<CallJsonOutcome> {
  try {
    return { ok: true, raw: await withRetry(() => client.generateJson(prompt, schema), options) }
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      return { ok: false, reason: 'quota', message: summarizeError(err), attempts: 1 }
    }
    if (err instanceof RetriesExhaustedError) {
      return { ok: false, reason: 'exhausted', message: summarizeError(err), attempts: options.maxAttempts }
    }
    throw err
  }
}

// The phrase the caller's log line needs: "quota exhausted" or "request failed
// after 5 attempts". Kept here so the two branches read the same everywhere.
export function failureText(outcome: Extract<CallJsonOutcome, { ok: false }>): string {
  return outcome.reason === 'quota' ? 'quota exhausted' : `request failed after ${outcome.attempts} attempts`
}
