import { ESLint } from 'eslint'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The shared rules have their own violating fixtures in @k-b3r/agent-config.
// This guards the repo's scoping: a too-wide entryPoints or defaultExportAllowed
// glob would silently switch a rule off for domain code.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: repoRoot })

type RuleEntry = [string | number, ...unknown[]]

async function rule(file: string, name: string): Promise<RuleEntry | undefined> {
  const config = (await eslint.calculateConfigForFile(path.join(repoRoot, file))) as {
    rules: Record<string, RuleEntry>
  }
  return config.rules[name]
}

const severity = (entry: RuleEntry | undefined) => (entry ? entry[0] : 'off')
const selectors = (entry: RuleEntry | undefined) =>
  (entry?.slice(1) as { selector: string }[] | undefined)?.map((option) => option.selector) ?? []

test('lint config bans process.env in domain, platform and server modules', async () => {
  for (const file of [
    'src/modules/catalog/products.ts',
    'src/platform/storage.ts',
    'src/platform/env.ts',
    'server/routes/query.ts',
    'server/proxyGuard.ts',
  ]) {
    expect([file, severity(await rule(file, 'no-restricted-properties'))]).toEqual([file, 2])
  }
}, 60_000)

test('lint config lets entry points read process.env', async () => {
  for (const file of ['src/workers/collect/index.ts', 'src/utils/backfill/index.ts', 'server/index.ts']) {
    expect([file, severity(await rule(file, 'no-restricted-properties'))]).toEqual([file, 0])
  }
}, 60_000)

test('lint config bans inline sleeps, export * and default exports in domain code', async () => {
  const found = selectors(await rule('src/modules/catalog/products.ts', 'no-restricted-syntax'))
  expect(found).toEqual(
    expect.arrayContaining([
      'ExportAllDeclaration',
      'ExportDefaultDeclaration',
      expect.stringContaining("callee.name='setTimeout'"),
    ]),
  )
}, 60_000)

test('lint config blocks oversized or complex entry points, where the shared config only warns', async () => {
  for (const file of [
    'src/workers/collect/index.ts',
    'src/utils/backfill/index.ts',
    'server/routes/workerControl.ts',
  ]) {
    expect([file, severity(await rule(file, 'max-lines')), severity(await rule(file, 'complexity'))]).toEqual([
      file,
      2,
      2,
    ])
  }
}, 60_000)

test('lint config keeps size and complexity as warnings outside entry points', async () => {
  for (const file of ['src/modules/catalog/products.ts', 'src/workers/collect/laps.ts', 'server/app.ts']) {
    expect([file, severity(await rule(file, 'max-lines')), severity(await rule(file, 'complexity'))]).toEqual([
      file,
      1,
      1,
    ])
  }
}, 60_000)

test('lint config leaves entry-point tests out of the size limit', async () => {
  expect(severity(await rule('server/routes/workerControl.test.ts', 'max-lines'))).toBe(0)
}, 60_000)

test('lint config allows default exports only in framework files', async () => {
  expect(selectors(await rule('dashboard/src/app/page.tsx', 'no-restricted-syntax'))).not.toContain(
    'ExportDefaultDeclaration',
  )
  expect(selectors(await rule('server/app.ts', 'no-restricted-syntax'))).toContain('ExportDefaultDeclaration')
}, 60_000)
