// Reads the optional limit argument from a script's CLI args.
export function readLimitArg(args: string[]): string | undefined {
  return getFirstArg(args)
}

function getFirstArg(args: string[]): string | undefined {
  return args[0]
}

export function parseLimit(raw: string): number {
  return toNumber(raw)
}

function toNumber(raw: string): number {
  return Number(raw)
}
