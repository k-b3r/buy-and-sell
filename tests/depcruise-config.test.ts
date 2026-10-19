import { cruise, type ICruiseResult } from 'dependency-cruiser'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// The repo's real rules, not a copy: a rule that exists but is scoped to nothing fails these tests.
const config = require('../.dependency-cruiser.cjs')

const fixture = (name: string) => fileURLToPath(new URL(`./lint-fixtures/${name}/`, import.meta.url))

// dependency-cruiser resolves from the process cwd, like the pnpm script run at the repo root.
async function violations(name: string, entries: string[], rule: string): Promise<string[]> {
  const cwd = process.cwd()
  process.chdir(fixture(name))
  try {
    const result = await cruise(
      entries,
      { ruleSet: { forbidden: config.forbidden }, validate: true, ...config.options },
      {},
      { tsConfig: extractTSConfig('tsconfig.json') },
    )
    return (result.output as ICruiseResult).summary.violations
      .filter((violation) => violation.rule.name === rule)
      .map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`)
      .sort()
  } finally {
    process.chdir(cwd)
  }
}

test('dependency-cruiser bans store, clients and app imports from a module domain folder', async () => {
  expect(await violations('depcruise-domain', ['src'], 'domain-no-effects')).toEqual([
    'domain-no-effects: src/modules/catalog/domain/calls-app.ts -> src/modules/catalog/app/use.ts',
    'domain-no-effects: src/modules/catalog/domain/calls-clients.ts -> src/modules/catalog/clients/http.ts',
    'domain-no-effects: src/modules/catalog/domain/calls-platform.ts -> src/platform/logger.ts',
    'domain-no-effects: src/modules/catalog/domain/calls-platform.ts -> src/platform/storage.ts',
    'domain-no-effects: src/modules/catalog/domain/names-store.ts -> src/modules/catalog/store/rows.ts',
  ])
}, 60_000)

test('dependency-cruiser sends entry points through a module index, browser excepted', async () => {
  expect(await violations('depcruise-entries', ['src', 'server', 'scripts'], 'entries-through-module-api')).toEqual([
    'entries-through-module-api: scripts/gen-arch-doc.ts -> src/modules/collection/app/use.ts',
    'entries-through-module-api: src/utils/backfill/index.ts -> src/modules/collection/store/rows.ts',
    'entries-through-module-api: src/workers/collect/index.ts -> src/modules/collection/domain/collect.ts',
  ])
}, 60_000)
