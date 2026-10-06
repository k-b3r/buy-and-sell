import fs from 'node:fs'
import { Project } from 'ts-morph'
import { DASHBOARD_SHARED_PATH, loadModulesProject, renderDashboardShared } from './gen-dashboard-shared'

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true })
  for (const [path, text] of Object.entries(files)) project.createSourceFile(path, text)
  return project
}

test('renderDashboardShared copies the named exports from a module index, following re-exports', async () => {
  const project = projectWith({
    '/m/index.ts': "export type { Thing } from './types'\nexport { LIST } from './list'\n",
    '/m/types.ts': '// internal note\nexport interface Thing {\n  id: string\n}\n',
    '/m/list.ts': "export const LIST = ['a', 'b'] as const\n",
  })

  const out = await renderDashboardShared(project, [{ index: '/m/index.ts', names: ['Thing', 'LIST'] }])

  expect(out).toContain('@generated')
  expect(out).toContain('export interface Thing {\n  id: string\n}')
  expect(out).toContain("export const LIST = ['a', 'b'] as const")
  expect(out).not.toContain('internal note')
})

test('renderDashboardShared also copies the types a requested type references, even unexported ones, once each', async () => {
  const project = projectWith({
    '/m/index.ts': "export type { Row, Other } from './rows'\n",
    '/m/rows.ts':
      "import type { Band } from './bands'\n" +
      'interface Inner {\n  band: Band\n}\n' +
      'type Tier = "a" | "b"\n' +
      'export interface Row {\n  inner: Inner\n  tier: Tier | null\n  when: Date\n}\n' +
      'export interface Other {\n  bands: Band[]\n}\n',
    '/m/bands.ts': 'export interface Band {\n  floor: number\n}\n',
  })

  const out = await renderDashboardShared(project, [{ index: '/m/index.ts', names: ['Row', 'Other'] }])

  expect(out).toContain('export interface Inner {')
  expect(out).toContain("export type Tier = 'a' | 'b'")
  expect(out.match(/export interface Band \{/g)).toHaveLength(1)
  expect(out).not.toContain('interface Date')
})

test('renderDashboardShared copies a requested function with the module-level functions and constants it uses', async () => {
  const project = projectWith({
    '/m/index.ts': "export { isCheap } from './rules'\n",
    '/m/rules.ts':
      "import { isRound } from './round'\n" +
      'const LIMIT = 100\n' +
      'export function isCheap(price: number): boolean {\n  const local = price\n  return local < LIMIT && !isRound(local)\n}\n',
    '/m/round.ts': 'export function isRound(n: number): boolean {\n  return n % 10 === 0\n}\n',
  })

  const out = await renderDashboardShared(project, [{ index: '/m/index.ts', names: ['isCheap'] }])

  expect(out).toContain('export function isCheap(price: number): boolean {')
  expect(out).toContain('export const LIMIT = 100')
  expect(out).toContain('export function isRound(n: number): boolean {')
  expect(out).not.toContain('import')
  expect(out.match(/const local/g)).toHaveLength(1)
})

test('renderDashboardShared fails when two different declarations would share one name', async () => {
  const project = projectWith({
    '/a/index.ts': 'export interface Thing {\n  a: string\n}\n',
    '/b/index.ts': 'export interface Thing {\n  b: string\n}\n',
  })

  await expect(
    renderDashboardShared(project, [
      { index: '/a/index.ts', names: ['Thing'] },
      { index: '/b/index.ts', names: ['Thing'] },
    ]),
  ).rejects.toThrow(/Thing/)
})

test('renderDashboardShared fails when a module index does not export a requested name', async () => {
  const project = projectWith({ '/m/index.ts': 'export const OTHER = 1\n' })

  await expect(renderDashboardShared(project, [{ index: '/m/index.ts', names: ['Missing'] }])).rejects.toThrow(
    /Missing/,
  )
})

test('the committed dashboard shared file matches what the generator produces from the modules', async () => {
  const expected = await renderDashboardShared(loadModulesProject('.'))

  expect(fs.readFileSync(DASHBOARD_SHARED_PATH, 'utf8')).toBe(expected)
})
