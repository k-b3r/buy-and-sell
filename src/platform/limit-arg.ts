// The optional positive-integer `limit` argument of the worker and util CLIs.
// undefined when absent; throws on anything that isn't a whole number >= 1, so a
// typo never turns into an uncapped run.
export function parseLimitArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid limit argument: "${raw}"`)
  return parsed
}
