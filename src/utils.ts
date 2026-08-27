import { existsSync } from 'node:fs'

// Generic, non-domain helpers only. DB connection lives in storage/client.ts;
// domain-specific queries live in each worker's own storage.ts.

export type DelayFn = (ms: number) => Promise<void>

export const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every worker's main() calls this first - loading .env is a no-op in
// production (env vars set directly), only matters for local/manual runs.
export function loadEnvFile(): void {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
}
