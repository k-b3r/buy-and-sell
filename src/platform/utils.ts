import { existsSync, writeFileSync } from 'node:fs'

// Generic, non-domain helpers only. DB connection lives in storage.ts;
// domain-specific queries live in domains/marketplace/storage/.

export type DelayFn = (ms: number) => Promise<void>

export const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
// Facebook.
export function isTestRun(): boolean {
  return process.env.TEST_RUN === 'true'
}

// Self-registration for server/routes/workerControl.ts's stop/status checks -
// written unconditionally on startup regardless of how the process was
// launched (by hand or via that route's spawn), so both are stoppable the
// same way. No cleanup-on-exit: a stale file after a crash is harmless,
// since liveness is always re-checked with process.kill(pid, 0), never
// trusted from the file's existence alone.
export function writePidFile(path: string): void {
  writeFileSync(path, String(process.pid))
}
