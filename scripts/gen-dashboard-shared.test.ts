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
