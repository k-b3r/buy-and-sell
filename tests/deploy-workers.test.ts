import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { WORKER_LOG_FILES } from '../server/routes/logs'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// scripts/deploy-server.sh restarts every worker after `systemctl restart`,
// because systemd's default cgroup-wide kill takes the detached worker
// children with it. The script keeps its own copy of the worker list (no
// shared import path between a bash script and the TS source), so a worker
// added to the server but not to that copy is silently killed and never
// restarted - confirmed live 2026-10-26: extract-real-estate stayed down
// after a deploy.
describe('scripts/deploy-server.sh', () => {
  test('restarts every worker the server can run', () => {
    const match = read('scripts/deploy-server.sh').match(/^WORKERS="([^"]*)"$/m)
    expect(match, 'no WORKERS="..." line in scripts/deploy-server.sh').not.toBeNull()

    const restarted = match![1].split(/\s+/).sort()
    expect(restarted).toEqual(Object.keys(WORKER_LOG_FILES).sort())
  })
})
