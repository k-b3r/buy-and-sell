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
  'claude-price-lookup': 'claude-price-lookup.pid',
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
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; detached: boolean; stdio: ['ignore', 'ignore', number] },
  ) => { pid?: number; on: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
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
  // In-memory only, per running server process - tracks whether each
  // worker's most recently FINISHED run (spawned via this route) ended in a
  // genuine code-level error, for the dashboard's red-on-error tab styling.
  // Only ever set from the spawned child's own 'exit' event below, never
  // cleared by a later Start action itself - a crash should stay visibly red
  // until the NEXT run actually concludes, not the moment you retry it.
  // Can't track a hand-started worker's crash this way (no child handle to
  // listen on) - same inherent limitation as the pid-file-race fix, only
  // covers runs started through this route.
  const lastRunErrored = new Map<string, boolean>()
  // Set by the 'stop' action right before signaling, checked first in the
  // exit handler below - NOT relying on the exit event's own (code, signal)
  // shape to recognize "this was an intentional stop". Confirmed live: our
  // own SIGTERM goes to the pid-file PID (the true leaf worker once
  // self-registered), but child.on('exit') below fires for the spawned NPX
  // WRAPPER process instead (a different PID higher up the npx->sh->tsx-cli
  // chain) - npm's wrapper often relays its child's signal-kill as its OWN
  // plain non-zero exit *code* with signal=null, which the naive
  // code/signal heuristic misread as a real crash on every ordinary Stop.
  const stoppedIntentionally = new Set<string>()

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
      return { statusCode: 200, body: { running: currentPid !== null, lastRunErrored: lastRunErrored.get(worker) ?? false } }
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
      if (currentPid !== null) {
        stoppedIntentionally.add(worker)
        deps.kill(currentPid, 'SIGTERM')
      }
      return { statusCode: 200, body: { running: false, lastRunErrored: lastRunErrored.get(worker) ?? false } }
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
    // A stop for THIS worker requested before this new run's own exit fires
    // is treated as intentional regardless of what (code, signal) shape the
    // wrapper reports - see stoppedIntentionally's comment. Otherwise, a
    // real exit code from the worker's own process.exit (its main().catch
    // guard uses exit(1)) counts as an error; signal !== null with no prior
    // stop request means something external killed it, also not a coded
    // failure. Deliberately does NOT clear a prior true value just because a
    // new run started - see lastRunErrored's own comment.
    child.on('exit', (code, signal) => {
      if (stoppedIntentionally.delete(worker)) {
        lastRunErrored.set(worker, false)
      } else if (signal === null && code !== 0) {
        lastRunErrored.set(worker, true)
      } else if (signal === null && code === 0) {
        lastRunErrored.set(worker, false)
      }
    })
    return { statusCode: 200, body: { running: true, lastRunErrored: lastRunErrored.get(worker) ?? false } }
  }
}
