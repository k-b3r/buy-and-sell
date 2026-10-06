// The one fatal-vs-transient rule for every LLM/search caller. A quota error
// (429, a key's or model's daily budget gone) is fatal for that client:
// retrying only burns time, so a pool drops the client and a retry loop
// unwinds. Every other error (400 shape glitch, 5xx, network, JSON parse) is
// transient and worth retrying.

// Thrown to unwind out of retry/split recursion and stop the run. A 429 says
// the key is dead, nothing about the batch, so retrying smaller does not help.
export class QuotaExhaustedError extends Error {
  override name = 'QuotaExhaustedError'
}

// SDK errors (groq-sdk, @google/genai) and this repo's fetch clients both
// carry the HTTP status as a numeric `status` field.
export function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof QuotaExhaustedError || errorStatus(err) === 429
}

// 402 is Exa's and OpenRouter's credits-exhausted signal (confirmed live
// 2026-08-28 for Exa: the error body tags NO_MORE_CREDITS). Same "this key is
// done for now" shape as a 429, so client pools treat it as exhaustion.
export function isCreditsError(err: unknown): boolean {
  return errorStatus(err) === 402
}
