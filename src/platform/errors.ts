// An LLM SDK's error message can be a huge JSON blob - e.g. Groq's 400
// json_validate_failed echoes back the model's entire (malformed) output in
// `failed_generation`. Callers that want a one-line "what happened" for a
// log, not a dump, log this instead of err.message directly.
export function summarizeError(err: unknown, maxLength = 200): string {
  const message = err instanceof Error ? err.message : String(err)
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}
