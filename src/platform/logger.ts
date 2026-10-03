import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

// A worker's log is a live "is it working" view (server/routes/logs.ts only
// ever tails the last 200 lines of it for the dashboard) - not a permanent
// record worth keeping in full. Capping the file itself at MAX_LOG_LINES
// means a worker stuck in a tight failure loop can never grow its log past a
// few hundred lines' worth of disk, no matter how many times it logs -
// confirmed live 2026-09-03: a runaway collect loop with no backoff wrote a
// 16GB collector.log, which then crashed the dashboard's refresh server
// every time it tried to read that file's tail.
export const MAX_LOG_LINES = 500

function trimToMaxLines(logFilePath: string): void {
  let content: string
  try {
    content = readFileSync(logFilePath, 'utf8')
  } catch {
    return
  }
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop() // drop the trailing empty entry from the file's final newline
  if (lines.length <= MAX_LOG_LINES) return
  writeFileSync(logFilePath, lines.slice(-MAX_LOG_LINES).join('\n') + '\n')
}

function writeLine(logFilePath: string, level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`
  console.log(line)
  appendFileSync(logFilePath, line + '\n')
  // Trimmed after every single write, not periodically - the file can never
  // exceed MAX_LOG_LINES at any point in time, including mid-tight-loop.
  trimToMaxLines(logFilePath)
}

export function createLogger(logFilePath: string): Logger {
  // data/ is gitignored, so a fresh clone or new host doesn't have it yet.
  mkdirSync(dirname(logFilePath), { recursive: true })
  return {
    info: (msg) => writeLine(logFilePath, 'INFO', msg),
    warn: (msg) => writeLine(logFilePath, 'WARN', msg),
    error: (msg) => writeLine(logFilePath, 'ERROR', msg),
  }
}
