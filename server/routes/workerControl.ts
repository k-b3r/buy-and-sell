import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn as spawnProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouteHandler, RouteResult } from '../app'
import { WORKER_LOG_FILES } from './logs'

// Same worker-key allowlist as logs.ts, extended with the pid-file name each
// worker writes on startup (src/platform/utils.ts's writePidFile) - matches
// its own log file's base name, just swapping .log for .pid.
export const WORKER_PID_FILES: Record<string, string> = {
  collect: 'collector.pid',
  'check-listings': 'check-listings.pid',
  'extract-products': 'extract-products.pid',
  'enrich-products': 'enrich-products.pid',
  'secondhand-price-lookup': 'secondhand-price-lookup.pid',
  'retail-price-lookup': 'retail-price-lookup.pid',
  'enrich-listing-prices': 'enrich-listing-prices.pid',
}

// Every worker key's directory under src/workers/ matches the key exactly
// (confirmed against the actual tree - no separate lookup table needed).
function scriptPathFor(worker: string): string {
  return `src/workers/${worker}/index.ts`
}

export interface WorkerControlDeps {
  isAlive: (pid: number) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  spawn: (command: string, args: string[], options: { cwd: string; detached: boolean; stdio: ['ignore', 'ignore', number] }) => { pid?: number }
}

const defaultDeps: WorkerControlDeps = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  spawn: (command, args, options) => spawnProcess(command, args, options),
}

// server/routes/ -> .. = server/ -> ../.. = repo root, same resolution as
// logs.ts and for the same reason (server/index.ts runs with CWD=server/).
const defaultDataDir = path.join(fileURLToPath(new URL('.', import.meta.url)), '../../data')
const defaultRepoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '../..')

function readAlivePid(pidFile: string, isAlive: WorkerControlDeps['isAlive']): number | null {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || !isAlive(pid)) return null
  return pid
}

// Dashboard's /admin/logs page - start/stop/status for a worker process.
// Workers self-register their own pid (writePidFile, called from their own
// main()) regardless of how they were launched, so this works the same for
// a hand-started process and one spawned by this route's own 'start' action.
// A stale pid file (crashed without cleanup) is indistinguishable from "not
// running" - isAlive is always re-checked live, never trusted from the
// file's mere existence.
export function createWorkerControlHandler(
  dataDir: string = defaultDataDir,
  deps: WorkerControlDeps = defaultDeps,
  repoRoot: string = defaultRepoRoot,
): RouteHandler {
  return async function handleWorkerControl(body: unknown): Promise<RouteResult> {
    const req = (body as Record<string, unknown> | null) ?? {}
    const worker = req.worker
    if (typeof worker !== 'string' || !(worker in WORKER_PID_FILES)) {
      return { statusCode: 400, body: { error: 'unknown "worker"' } }
    }
    const action = req.action
    if (action !== 'start' && action !== 'stop' && action !== 'status') {
      return { statusCode: 400, body: { error: 'unknown "action"' } }
    }

    const pidFile = path.join(dataDir, WORKER_PID_FILES[worker])
    const currentPid = readAlivePid(pidFile, deps.isAlive)

    if (action === 'status') {
      return { statusCode: 200, body: { running: currentPid !== null } }
    }

    if (action === 'stop') {
      // Most of these worker loops have no signal handler, so SIGTERM
      // terminates them immediately (confirmed live) - same as SIGKILL would,
      // no graceful-shutdown plumbing exists or is needed here (see the
      // corruption-risk discussion this route followed from). check-listings
      // is the one exception: playwright-core installs its own SIGTERM
      // handler for browser cleanup, so that one takes a few seconds to
      // actually exit (confirmed live, ~1-3s) rather than dying instantly -
      // the UI's status poll just needs to catch up, no code-level fix
      // needed for that.
      if (currentPid !== null) deps.kill(currentPid, 'SIGTERM')
      return { statusCode: 200, body: { running: false } }
    }

    // start
    if (currentPid !== null) {
      return { statusCode: 409, body: { error: `${worker} is already running` } }
    }
    // Fresh run, fresh log - a Start click means "show me this run", not the
    // last one's output still sitting above it. Only this route's own start
    // clears it; createLogger itself still just appends, so a hand-started
    // `pnpm run <worker>` keeps its history like before.
    const logFile = path.join(dataDir, WORKER_LOG_FILES[worker])
    if (existsSync(logFile)) writeFileSync(logFile, '')
    // stderr only, redirected into the worker's own log file instead of
    // discarded - a worker crashing (uncaught exception, Playwright/Chromium
    // dying) hits its top-level `main().catch(err => console.error(err))`
    // guard, which used to go to stdio:'ignore' and vanish, leaving the log
    // looking like it just stopped for no reason with nothing to debug
    // (confirmed live). stdout stays 'ignore': createLogger's logger.info/warn
    // already writes each line to BOTH stdout (console.log) and this same
    // file (appendFileSync) - redirecting stdout here too would duplicate
    // every normal line (confirmed live: each line appeared twice).
    const logFd = openSync(logFile, 'a')
    // detached + unref: this process outlives the request/the server
    // itself, same as a hand-started `pnpm run <worker>` would. No env
    // override - the worker's own loadEnvFile() picks up repoRoot's .env same
    // as always, since cwd is set to repoRoot below.
    const child = deps.spawn('npx', ['tsx', scriptPathFor(worker)], { cwd: repoRoot, detached: true, stdio: ['ignore', 'ignore', logFd] })
    // The child has its own duped copy of the fd once spawned - this
    // process's own reference must be closed or it leaks for the server's
    // entire (long) lifetime, one per worker start.
    closeSync(logFd)
    // Written immediately with the spawned (wrapper) pid, not left to the
    // worker's own self-registration - that takes a real few seconds (tsx
    // startup, imports, Playwright launch), and until it happens the pid
    // file still shows the PREVIOUS run's stale/dead pid. A status poll or
    // second Start click landing in that window would see "not running" and
    // either flip the button back or spawn a duplicate process - confirmed
    // live: a second click during exactly this gap ran two concurrent
    // `collect` instances against the same DB. The worker's own writePidFile
    // overwrites this moments later with its more precise leaf pid; until
    // then this wrapper pid is a correct enough "something is running" fact.
    if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid))
    if (typeof (child as { unref?: () => void }).unref === 'function') {
      ;(child as { unref: () => void }).unref()
    }
    return { statusCode: 200, body: { running: true } }
  }
}
