import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Express } from 'express'
import request from 'supertest'
import type { ListingPhotos } from '../../src/modules/collection'
import type { QueryClient } from '../../src/platform/storage'
import { createApp } from '../app'
import { createRefreshHandlers, createRefreshRouter } from '../refreshHandlers'
import { createLogsRouter } from './logs'
import { createWorkerControlRouter } from './workerControl'

const API_KEY = 'test-key'
const AUTH = `Bearer ${API_KEY}`

// Every route the old body-driven table served. `post` is a body its handler
// rejects cheaply: no database read, no log file read, no worker touched.
const MOVED_ROUTES: ReadonlyArray<{ path: string; status: number; post?: object }> = [
  { path: '/refresh', status: 400, post: {} },
  { path: '/refresh-product', status: 400, post: {} },
  { path: '/refresh-job', status: 200 },
  { path: '/refresh-job/cancel', status: 400, post: {} },
  { path: '/logs', status: 400, post: { worker: 'not-a-worker' } },
  { path: '/worker-control', status: 400, post: { worker: 'not-a-worker', action: 'status' } },
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'moved-routes-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function app(): Express {
  const refresh = createRefreshHandlers({
    db: {} as QueryClient,
    photos: {} as ListingPhotos,
    logger: { info() {}, warn() {}, error() {} },
    env: {},
    cache: { invalidate() {} },
  })
  return createApp({
    apiKey: API_KEY,
    log: () => {},
    routers: [
      createRefreshRouter(refresh),
      createLogsRouter(dir),
      createWorkerControlRouter(dir, {
        isAlive: () => false,
        kill: vi.fn(),
        spawn: vi.fn(),
        delay: async () => {},
      }),
    ],
  })
}

function send(server: Express, route: (typeof MOVED_ROUTES)[number], authorized: boolean) {
  const req =
    route.post === undefined ? request(server).get(route.path) : request(server).post(route.path).send(route.post)
  return authorized ? req.set('authorization', AUTH) : req
}

test('every route folded out of the old table answers 401 without the bearer key', async () => {
  const server = app()

  for (const route of MOVED_ROUTES) {
    const res = await send(server, route, false)
    expect([route.path, res.status]).toEqual([route.path, 401])
  }
})

test('with the key each folded route reaches its handler instead of 404ing', async () => {
  const server = app()

  for (const route of MOVED_ROUTES) {
    const res = await send(server, route, true)
    expect([route.path, res.status]).toEqual([route.path, route.status])
  }
})
