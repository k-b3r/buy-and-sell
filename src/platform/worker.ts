import { writeFileSync } from 'node:fs'
import { realDelay } from './delay'
import type { DelayFn } from './delay'
import { createLogger } from './logger'
import type { Logger } from './logger'
import { loadSettings } from './settings'
import { createDbPool } from './storage'
import type { DbClient } from './storage'

// Shared scaffolding for every looping worker in src/workers/: pid/log files,
// the DB pool's lifetime, the lap loop, settings reloaded each lap, the sleep
// between laps and TEST_RUN dry runs. A worker's entry point only builds its
// clients (setup) and says what one lap does (the returned Lap).

export interface WorkerIo {
  logger: Logger
  db: DbClient
}

interface LapContext {
  lap: number
  settings: Record<string, number>
}

// A lap gathers its candidates (always, even on a test run - cheap DB reads)
// and returns what it would do with them, so the runner, not each worker,
// decides whether the paid/live part actually runs.
interface LapPlan {
  // Logged as `TEST_RUN: <dryRun>` in place of run() on a test run.
  dryRun: string
  run: () => Promise<void>
}

type Lap = (ctx: LapContext) => Promise<LapPlan>

export interface WorkerConfig {
  // data/<name>.log and data/<name>.pid
  name: string
  databaseUrl: string
  // See isTestRun (env.ts).
  testRun: boolean
  // Reloaded every lap so a dashboard edit takes effect without a restart.
  settingKeys: string[]
  loopDelayKey: string
  setup: (io: WorkerIo) => Lap | Promise<Lap>
}

interface WorkerPool extends DbClient {
  end(): Promise<void>
}

export interface WorkerDeps {
  createLogger: (path: string) => Logger
  writePidFile: (path: string) => void
  createDbPool: (connectionString: string) => WorkerPool
  delay: DelayFn
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

const realDeps: WorkerDeps = { createLogger, writePidFile, createDbPool, delay: realDelay }

// The process-lifetime half of runWorker, for a worker whose loop doesn't fit
// the standard lap shape (collect). The pool is ended however body finishes.
export async function runWorkerProcess(
  name: string,
  databaseUrl: string,
  body: (io: WorkerIo) => Promise<void>,
  deps: WorkerDeps = realDeps,
): Promise<void> {
  const logger = deps.createLogger(`data/${name}.log`)
  deps.writePidFile(`data/${name}.pid`)
  const pool = deps.createDbPool(databaseUrl)
  try {
    await body({ logger, db: pool })
  } finally {
    await pool.end()
  }
}

// Loops until a lap (or the delay) throws; the pool is ended on the way out.
export async function runWorker(config: WorkerConfig, deps: WorkerDeps = realDeps): Promise<void> {
  const settingKeys = config.settingKeys.includes(config.loopDelayKey)
    ? config.settingKeys
    : [...config.settingKeys, config.loopDelayKey]

  await runWorkerProcess(
    config.name,
    config.databaseUrl,
    async ({ logger, db }) => {
      const runLap = await config.setup({ logger, db })
      logger.info('looping indefinitely — Ctrl+C to stop')
      for (let lap = 1; ; lap++) {
        logger.info(`lap ${lap} starting`)
        const settings = await loadSettings(db, settingKeys)
        const plan = await runLap({ lap, settings })
        if (config.testRun) {
          logger.info(`TEST_RUN: ${plan.dryRun}`)
        } else {
          await plan.run()
        }
        const loopDelayMs = settings[config.loopDelayKey]
        logger.info(`lap ${lap} complete, sleeping ${loopDelayMs}ms`)
        await deps.delay(loopDelayMs)
      }
    },
    deps,
  )
}
