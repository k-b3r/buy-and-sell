import { Project } from 'ts-morph'
import { extractArchitecture, renderDomainMarkdown, slugify } from './gen-arch-doc.ts'

function makeProject() {
  return new Project({ useInMemoryFileSystem: true })
}

test('extracts a documented function with signature and description', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/src/workers/foo/index.ts',
    `/** Enriches one product. */\nexport function enrichProduct(id: number): Promise<void> {\n  return Promise.resolve()\n}\n`,
  )

  const domains = extractArchitecture(project, '/repo/src', 'src', () => 'workers')

  expect(domains).toEqual([
    {
      name: 'workers',
      modules: [
        {
          path: 'src/workers/foo/index.ts',
          imports: [],
          functions: [
            {
              name: 'enrichProduct',
              signature: 'enrichProduct(id: number): Promise<void>',
              description: 'Enriches one product.',
              isClass: false,
            },
          ],
        },
      ],
    },
  ])
})

test('flags an undocumented function with a null description', () => {
  const project = makeProject()
  project.createSourceFile('/repo/src/utils/bar.ts', `export function bar(): void {}\n`)

  const [domain] = extractArchitecture(project, '/repo/src', 'src', () => 'utils')

  expect(domain.modules[0].functions[0].description).toBeNull()
})

test('records in-repo relative imports as interactions, skips package imports', () => {
  const project = makeProject()
  project.createSourceFile('/repo/src/domains/marketplace/products.ts', `export function getProduct(): void {}\n`)
  project.createSourceFile(
    '/repo/src/workers/foo/index.ts',
    `import { getProduct } from '../../domains/marketplace/products'\nimport { z } from 'zod'\n\nexport function run(): void {}\n`,
  )

  const domains = extractArchitecture(project, '/repo/src', 'src', (relPath) => relPath.split('/')[0])
  const fooModule = domains.flatMap((d) => d.modules).find((m) => m.path.endsWith('foo/index.ts'))

  expect(fooModule?.imports).toEqual(['../../domains/marketplace/products'])
})

test('treats @/ specifiers as in-repo when isInRepoImport allows it', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/dashboard/src/app/api/deals/route.ts',
    `import { getDeals } from '@/lib/queries'\nimport { NextResponse } from 'next/server'\n\nexport function run(): void {}\n`,
  )

  const domains = extractArchitecture(
    project,
    '/repo/dashboard/src',
    'dashboard/src',
    () => 'app/api',
    (spec) => spec.startsWith('.') || spec.startsWith('@/'),
  )

  expect(domains[0].modules[0].imports).toEqual(['@/lib/queries'])
})

test('excludes class declarations from marking isClass true and captures class name as signature', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/src/platform/thing.ts',
    `/** Does the thing. */\nexport class Thing {\n  run(): void {}\n}\n`,
  )

  const [domain] = extractArchitecture(project, '/repo/src', 'src', () => 'platform')

  expect(domain.modules[0].functions[0]).toEqual({
    name: 'Thing',
    signature: 'class Thing',
    description: 'Does the thing.',
    isClass: true,
  })
})

test('skips test files entirely', () => {
  const project = makeProject()
  project.createSourceFile('/repo/src/utils/bar.test.ts', `export function shouldNotAppear(): void {}\n`)

  const domains = extractArchitecture(project, '/repo/src', 'src', () => 'utils')

  expect(domains).toEqual([])
})

test('renderDomainMarkdown renders a single domain page: title, module, function headers, interactions', () => {
  const md = renderDomainMarkdown('src', {
    name: 'workers',
    modules: [
      {
        path: 'src/workers/foo/index.ts',
        imports: ['../../domains/marketplace/products'],
        functions: [
          { name: 'run', signature: 'run(): void', description: null, isClass: false },
          {
            name: 'enrichProduct',
            signature: 'enrichProduct(id: number): Promise<void>',
            description: 'Enriches one product.',
            isClass: false,
          },
        ],
      },
    ],
  })

  expect(md).toContain('# workers')
  expect(md).toContain('## src/workers/foo/index.ts')
  expect(md).toContain('**Interactions:** imports `../../domains/marketplace/products`')
  expect(md).toContain('### `run(): void`')
  expect(md).toContain('_(undocumented)_')
  expect(md).toContain('### `enrichProduct(id: number): Promise<void>`')
  expect(md).toContain('Enriches one product.')
})

test('slugify converts a domain name to a filesystem-safe file slug', () => {
  expect(slugify('domains/llm-clients')).toBe('domains-llm-clients')
  expect(slugify('workers')).toBe('workers')
})
