import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function loadListings(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export function saveListings(path: string, listings: Record<string, unknown>[]): void {
  writeFileSync(path, listings.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
