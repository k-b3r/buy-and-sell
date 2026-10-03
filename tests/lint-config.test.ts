import { ESLint } from 'eslint'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Proves each guardrail rule actually fires: a mis-scoped glob or a dropped
// rule would otherwise silently check nothing.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lint-fixtures')
const repoRoot = path.resolve(fixtures, '../..')

async function ruleIdsFor(relPath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false })
  const [result] = await eslint.lintFiles([path.join(fixtures, relPath)])
  return result.messages.map((m) => m.ruleId ?? 'parse-error')
}

const cases: [string, string][] = [
  ['ts-ignore.ts', '@typescript-eslint/ban-ts-comment'],
  ['export-all.ts', 'no-restricted-syntax'],
  ['src/domains/fixture/export-all.ts', 'no-restricted-syntax'],
  ['explicit-any.ts', '@typescript-eslint/no-explicit-any'],
  ['undescribed-disable.ts', '@eslint-community/eslint-comments/require-description'],
  ['unlimited-disable.ts', '@eslint-community/eslint-comments/no-unlimited-disable'],
  ['src/domains/fixture/ambient-env.ts', 'no-restricted-properties'],
  ['src/domains/fixture/raw-sleep.ts', 'no-restricted-syntax'],
]

test.each(cases)(
  'lint config flags %s with %s',
  async (file, rule) => {
    expect(await ruleIdsFor(file)).toContain(rule)
  },
  60_000,
)

test('lint config passes the clean control fixture', async () => {
  expect(await ruleIdsFor('clean.ts')).toEqual([])
}, 60_000)
