import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Project } from 'ts-morph'
import { assertDepsInstalled, extractArchitecture, renderDomainMarkdown, slugify, writeSite } from './gen-arch-doc.ts'

function makeProject() {
  return new Project({ useInMemoryFileSystem: true })
}

test('extracts a documented function with signature and description', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/src/workers/foo/index.ts',
    `/** Enriches one product. */\nexport function enrichProduct(id: number): Promise<void> {\n  return Promise.resolve()\n}\n`,
  )

  const domains = extractArchitecture(project, { rootDir: '/repo/src', pathPrefix: 'src', domainOf: () => 'workers' })

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

  const [domain] = extractArchitecture(project, { rootDir: '/repo/src', pathPrefix: 'src', domainOf: () => 'utils' })

  expect(domain.modules[0].functions[0].description).toBeNull()
})

test('records in-repo relative imports as interactions, skips package imports', () => {
  const project = makeProject()
  project.createSourceFile('/repo/src/modules/catalog/products.ts', `export function getProduct(): void {}\n`)
  project.createSourceFile(
    '/repo/src/workers/foo/index.ts',
    `import { getProduct } from '../../modules/catalog/products'\nimport { z } from 'zod'\n\nexport function run(): void {}\n`,
  )

  const domains = extractArchitecture(project, {
    rootDir: '/repo/src',
    pathPrefix: 'src',
    domainOf: (relPath) => relPath.split('/')[0],
  })
  const fooModule = domains.flatMap((d) => d.modules).find((m) => m.path.endsWith('foo/index.ts'))

  expect(fooModule?.imports).toEqual(['../../modules/catalog/products'])
})

test('treats @/ specifiers as in-repo when isInRepoImport allows it', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/dashboard/src/app/api/deals/route.ts',
    `import { getDeals } from '@/lib/queries'\nimport { NextResponse } from 'next/server'\n\nexport function run(): void {}\n`,
  )

  const domains = extractArchitecture(project, {
    rootDir: '/repo/dashboard/src',
    pathPrefix: 'dashboard/src',
    domainOf: () => 'app/api',
    isInRepoImport: (spec) => spec.startsWith('.') || spec.startsWith('@/'),
  })

  expect(domains[0].modules[0].imports).toEqual(['@/lib/queries'])
})

test('excludes class declarations from marking isClass true and captures class name as signature', () => {
  const project = makeProject()
  project.createSourceFile(
    '/repo/src/platform/thing.ts',
    `/** Does the thing. */\nexport class Thing {\n  run(): void {}\n}\n`,
  )

  const [domain] = extractArchitecture(project, { rootDir: '/repo/src', pathPrefix: 'src', domainOf: () => 'platform' })

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

  const domains = extractArchitecture(project, { rootDir: '/repo/src', pathPrefix: 'src', domainOf: () => 'utils' })

  expect(domains).toEqual([])
})

test('renderDomainMarkdown renders a single domain page: title, module, function headers, interactions', () => {
  const md = renderDomainMarkdown('src', {
    name: 'workers',
    modules: [
      {
        path: 'src/workers/foo/index.ts',
        imports: ['../../modules/catalog/products'],
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
  expect(md).toContain('**Interactions:** imports `../../modules/catalog/products`')
  expect(md).toContain('### `run(): void`')
  expect(md).toContain('_(undocumented)_')
  expect(md).toContain('### `enrichProduct(id: number): Promise<void>`')
  expect(md).toContain('Enriches one product.')
})

test('slugify converts a domain name to a filesystem-safe file slug', () => {
  expect(slugify('app/api')).toBe('app-api')
  expect(slugify('workers')).toBe('workers')
})

test('inferred return types from other modules render without machine-specific absolute paths', () => {
  const project = makeProject()
  project.createSourceFile('/repo/src/lib/result.ts', `export interface Result {\n  ok: boolean\n}\n`)
  project.createSourceFile(
    '/repo/src/workers/foo/index.ts',
    `import { type Result } from '../../lib/result'\nexport function run() {\n  const r: Result = { ok: true }\n  return Promise.resolve(r)\n}\n`,
  )

  const [domain] = extractArchitecture(project, { rootDir: '/repo/src', pathPrefix: 'src', domainOf: () => 'workers' })
  const signature = domain.modules.find((m) => m.path === 'src/workers/foo/index.ts')!.functions[0].signature

  expect(signature).toBe('run(): Promise<Result>')
})

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gen-arch-doc-'))
}

const fooDomain = { name: 'foo', modules: [] }

test('writeSite deletes generated pages for domains that no longer exist', () => {
  const outDir = makeTmpDir()
  writeSite([{ name: 'src', domains: [fooDomain, { name: 'gone', modules: [] }] }], outDir)
  expect(fs.existsSync(path.join(outDir, 'src/gone.md'))).toBe(true)

  writeSite([{ name: 'src', domains: [fooDomain] }], outDir)

  expect(fs.existsSync(path.join(outDir, 'src/gone.md'))).toBe(false)
  expect(fs.existsSync(path.join(outDir, 'src/foo.md'))).toBe(true)
})

test('writeSite keeps hand-written pages that lack the generated marker', () => {
  const outDir = makeTmpDir()
  fs.mkdirSync(path.join(outDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(outDir, 'src/notes.md'), '# Notes\n\nWritten by a human.\n')

  writeSite([{ name: 'src', domains: [fooDomain] }], outDir)

  expect(fs.readFileSync(path.join(outDir, 'src/notes.md'), 'utf-8')).toContain('Written by a human.')
})

test('assertDepsInstalled throws an error naming the install command when a dependency is missing', () => {
  const dir = makeTmpDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '1' }, devDependencies: {} }))

  expect(() => assertDepsInstalled(dir, 'pnpm --dir dashboard install')).toThrow(/next.*pnpm --dir dashboard install/s)
})

test('assertDepsInstalled passes when every dependency is present in node_modules', () => {
  const dir = makeTmpDir()
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { next: '1' }, devDependencies: { '@types/react': '1' } }),
  )
  fs.mkdirSync(path.join(dir, 'node_modules/next'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/@types/react'), { recursive: true })

  expect(() => assertDepsInstalled(dir, 'pnpm --dir dashboard install')).not.toThrow()
})
