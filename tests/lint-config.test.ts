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
    'server/routes/refresh.ts',
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

test('lint config leaves curated data lists out of the size limit but keeps their complexity check', async () => {
  for (const file of [
    'src/modules/catalog/variant-alias-rules.ts',
    'src/modules/pricing/ineligible-categories.ts',
    'src/modules/pricing/domain/generic-products.ts',
  ]) {
    expect([file, severity(await rule(file, 'max-lines')), severity(await rule(file, 'complexity'))]).toEqual([
      file,
      0,
      1,
    ])
  }
}, 60_000)

test('lint config leaves entry-point tests out of the size limit', async () => {
  expect(severity(await rule('server/routes/workerControl.test.ts', 'max-lines'))).toBe(0)
}, 60_000)

const RUN_EXPORT_MARKER = '[id.name=/^run[A-Z]/]'
const isRunExportSelector = (selector: string) => selector.includes(RUN_EXPORT_MARKER)
const QUERY_SELECTOR = "CallExpression[callee.property.name='query']"

test('lint config bans .query() calls outside store/ in every module', async () => {
  for (const file of [
    'src/modules/catalog/merge.ts',
    'src/modules/catalog/product-list.ts',
    'src/modules/catalog/routes.ts',
  ]) {
    expect([file, selectors(await rule(file, 'no-restricted-syntax'))]).toEqual([
      file,
      expect.arrayContaining([QUERY_SELECTOR]),
    ])
  }
}, 60_000)

test('lint config lets store/ files and tests call .query()', async () => {
  for (const file of [
    'src/modules/catalog/store/products.ts',
    'src/modules/catalog/store/product-list.ts',
    'src/modules/catalog/merge.test.ts',
    'src/modules/catalog/store/products.test.ts',
  ]) {
    expect([file, selectors(await rule(file, 'no-restricted-syntax'))]).toEqual([
      file,
      expect.not.arrayContaining([QUERY_SELECTOR]),
    ])
  }
}, 60_000)

test('lint config leaves code outside src/modules free to call .query()', async () => {
  for (const file of ['src/platform/settings.ts', 'src/workers/enrich-products/run.ts']) {
    expect([file, selectors(await rule(file, 'no-restricted-syntax'))]).toEqual([
      file,
      expect.not.arrayContaining([QUERY_SELECTOR]),
    ])
  }
}, 60_000)

test('lint config keeps every other restricted-syntax ban in modules, so the module block cannot drift from the shared list', async () => {
  const enforced = selectors(await rule('src/modules/catalog/merge.ts', 'no-restricted-syntax'))
  const shared = selectors(await rule('src/platform/settings.ts', 'no-restricted-syntax'))
  expect(enforced.filter((selector) => selector !== QUERY_SELECTOR && !isRunExportSelector(selector))).toEqual(shared)
}, 60_000)

const RUN_EXPORT_CODE = [
  'export async function runThing() {}',
  'export const runOther = async () => {}',
  'function runThird() {}',
  'export { runThird }',
].join('\n')

async function runExportMessages(file: string, code = RUN_EXPORT_CODE) {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) })
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
}

test('lint config bans run* exports in every module', async () => {
  for (const file of ['src/modules/catalog/merge.ts', 'src/modules/real-estate/app/extractor.ts']) {
    expect([file, selectors(await rule(file, 'no-restricted-syntax'))]).toEqual([
      file,
      expect.arrayContaining([expect.stringContaining(RUN_EXPORT_MARKER), QUERY_SELECTOR]),
    ])
  }
}, 60_000)

test('lint reports every exported run* function, const and specifier in a module', async () => {
  expect(await runExportMessages('src/modules/catalog/merge.ts')).toHaveLength(3)
}, 60_000)

test('lint allows run* names that are not exported, not followed by a capital, or in module tests', async () => {
  expect(
    await runExportMessages('src/modules/catalog/merge.ts', 'function runLocal() {}\nexport const running = 1\n'),
  ).toHaveLength(0)
  expect(await runExportMessages('src/modules/catalog/merge.test.ts')).toHaveLength(0)
}, 60_000)

test('lint allows run* exports in worker run.ts files and outside src/modules', async () => {
  for (const file of ['src/platform/settings.ts', 'src/workers/enrich-products/run.ts']) {
    expect([file, await runExportMessages(file)]).toEqual([file, expect.not.arrayContaining([expect.anything()])])
  }
}, 60_000)

test('lint config keeps the pure-core bans and the module bans together in domain/ files', async () => {
  const domain = selectors(await rule('src/modules/real-estate/domain/extraction.ts', 'no-restricted-syntax'))
  expect(domain).toEqual(
    expect.arrayContaining([
      QUERY_SELECTOR,
      "NewExpression[callee.name='Date'][arguments.length=0]",
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      "CallExpression[callee.object.name='Math'][callee.property.name='random']",
      expect.stringContaining(RUN_EXPORT_MARKER),
    ]),
  )
  expect(
    selectors(await rule('src/modules/real-estate/domain/extraction.test.ts', 'no-restricted-syntax')),
  ).not.toContain("CallExpression[callee.object.name='Math'][callee.property.name='random']")
}, 60_000)

test('lint config bans fetch and process in domain/ files only', async () => {
  const globalsIn = async (file: string) =>
    ((await rule(file, 'no-restricted-globals'))?.slice(1) as { name: string }[] | undefined)?.map((g) => g.name) ?? []
  expect(await globalsIn('src/modules/real-estate/domain/extraction.ts')).toEqual(
    expect.arrayContaining(['fetch', 'process']),
  )
  expect(await globalsIn('src/modules/real-estate/app/extractor.ts')).not.toContain('fetch')
}, 60_000)

test('lint reports a .query() call outside store/ in a module and accepts it inside store/', async () => {
  const code = 'export async function f(db: { query(sql: string): Promise<unknown> }) { await db.query("SELECT 1") }\n'
  const outside = await eslint.lintText(code, { filePath: path.join(repoRoot, 'src/modules/catalog/merge.ts') })
  const inside = await eslint.lintText(code, { filePath: path.join(repoRoot, 'src/modules/catalog/store/products.ts') })
  expect(outside[0].messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(1)
  expect(inside[0].messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
}, 60_000)

test('lint config allows default exports only in framework files', async () => {
  expect(selectors(await rule('dashboard/src/app/page.tsx', 'no-restricted-syntax'))).not.toContain(
    'ExportDefaultDeclaration',
  )
  expect(selectors(await rule('server/app.ts', 'no-restricted-syntax'))).toContain('ExportDefaultDeclaration')
}, 60_000)
