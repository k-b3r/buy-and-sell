import { r2PhotoIoFromEnv, type R2PhotoIo } from '../src/platform/r2-photos'

const DEFAULT_PORT = 8787

export interface ServerConfig {
  apiKey: string
  dbUrl: string
  photoIo: R2PhotoIo
  port: number
}

// Reads and validates the server's env (server/.env, loaded by the entry point)
// in one place, so a missing var fails at startup with its name.
export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const apiKey = env.REFRESH_API_KEY
  if (!apiKey) throw new Error('REFRESH_API_KEY not set in .env')
  const dbUrl = env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — the server requires Postgres')

  const photoIo = r2PhotoIoFromEnv(env)
  if (!photoIo) throw new Error('R2 not fully configured in .env — the refresh route needs to be able to delete photos')

  return { apiKey, dbUrl, photoIo, port: Number(env.SERVER_PORT ?? DEFAULT_PORT) }
}
