import { writeFileSync } from 'node:fs'

// Self-registration for server/routes/workerControl.ts's stop/status checks -
// written unconditionally on startup regardless of how the process was
// launched (by hand or via that route's spawn), so both are stoppable the
// same way. No cleanup-on-exit: a stale file after a crash is harmless,
// since liveness is always re-checked with process.kill(pid, 0), never
// trusted from the file's existence alone.
export function writePidFile(path: string): void {
  writeFileSync(path, String(process.pid))
}
