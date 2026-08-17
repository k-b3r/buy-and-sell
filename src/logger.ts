import { appendFileSync } from 'node:fs'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

function writeLine(logFilePath: string, level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`
  console.log(line)
  appendFileSync(logFilePath, line + '\n')
}

export function createLogger(logFilePath: string): Logger {
  return {
    info: (msg) => writeLine(logFilePath, 'INFO', msg),
    warn: (msg) => writeLine(logFilePath, 'WARN', msg),
    error: (msg) => writeLine(logFilePath, 'ERROR', msg),
  }
}
