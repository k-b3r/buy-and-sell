import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { realDelay, type DelayFn } from './utils'

// Shared by collect and check-listings (the only two workers that launch a
// browser) - same data/ directory their pid/log files already live in.
export const BROWSER_LOCK_PATH = 'data/browser.lock'

export interface BrowserLockDeps {
  pid: number
  isAlive: (pid: number) => boolean
}

const defaultDeps: BrowserLockDeps = {
  pid: process.pid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
}

// collect and check-listings each hold a full headless Chromium open for
// their whole run - the VPS is 1 vCPU/1.9GB and already swaps hard with one
// instance up, so the two must never run concurrently (see
// project_ram_reduction memory). This is cross-PROCESS, unlike
// server/refreshLock.ts's in-memory flag - collect/check-listings are two
// independently launched OS processes (often hand-started, not both spawned
// by one parent), so coordination has to live on disk, same as
// writePidFile/readAlivePid's pattern in workerControl.ts.
//
// 'wx' makes the common case (lock free) a single atomic syscall - no
// read-then-write race. The EEXIST branch below only runs when something's
// already there.
export function tryAcquireBrowserLock(lockPath: string, deps: BrowserLockDeps = defaultDeps): boolean {
  try {
    writeFileSync(lockPath, String(deps.pid), { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const heldBy = Number(readFileSync(lockPath, 'utf8').trim())
  if (Number.isInteger(heldBy) && deps.isAlive(heldBy)) return false

  // Stale - the previous holder crashed without releasing it. Reclaim by
  // overwriting rather than unlink+rewrite: a second caller reclaiming at
  // the same instant just becomes the new "holder of record" on the last
  // write, the same non-catastrophic double-Chromium outcome this lock
  // exists to make rare, not eliminate at all costs.
  writeFileSync(lockPath, String(deps.pid))
  return true
}

export function releaseBrowserLock(lockPath: string, deps: BrowserLockDeps = defaultDeps): void {
  if (!existsSync(lockPath)) return
  const heldBy = Number(readFileSync(lockPath, 'utf8').trim())
  if (heldBy === deps.pid) unlinkSync(lockPath)
}

// Blocks (polling, not busy-waiting) until this process is the one holding
// the lock. Workers call this before launchBrowser() and release right
// after close() - see collect/index.ts and check-listings/index.ts.
export async function acquireBrowserLock(
  lockPath: string,
  logger: { info: (msg: string) => void },
  deps: BrowserLockDeps = defaultDeps,
  pollMs = 5000,
  delay: DelayFn = realDelay,
): Promise<void> {
  let waited = false
  while (!tryAcquireBrowserLock(lockPath, deps)) {
    if (!waited) {
      logger.info('browser lock held by another worker, waiting for it to finish...')
      waited = true
    }
    await delay(pollMs)
  }
}
