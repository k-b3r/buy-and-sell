import { existsSync } from 'node:fs'

// Every worker's main() calls this first - loading .env is a no-op in
// production (env vars set directly), only matters for local/manual runs.
export function loadEnvFile(): void {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
}

// Dry-run switch (.env TEST_RUN=true) - every worker still connects to
// Postgres and queries its real candidate set (cheap, no external cost), but
// skips the actual paid/live call (Gemini/Groq/Exa/live Facebook) and logs
// what it WOULD have called instead. Lets every worker's loop/pacing/DB
// wiring be watched end-to-end before spending real money or hitting live
// Facebook. Workers pass process.env from their entry point.
export function isTestRun(env: { TEST_RUN?: string }): boolean {
  return env.TEST_RUN === 'true'
}
