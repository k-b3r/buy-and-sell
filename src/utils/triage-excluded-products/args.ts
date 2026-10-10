// `--reasons a,b` for --apply. Absent means every reason; present but empty
// or malformed throws, because the fallback to "every reason" is the widest
// possible apply, the opposite of what a typo'd flag meant (PR review, BUY-60).
export function parseReasonsFlag(argv: string[]): string[] | undefined {
  const index = argv.indexOf('--reasons')
  if (index === -1) return undefined
  const value = argv[index + 1]
  const reasons = value && !value.startsWith('--') ? value.split(',').filter(Boolean) : []
  if (reasons.length === 0)
    throw new Error('--reasons needs a comma-separated list, e.g. --reasons retail_not_found,exa_no_result')
  return reasons
}
