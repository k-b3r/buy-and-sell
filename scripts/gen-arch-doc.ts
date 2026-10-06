import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { Node, Project } from 'ts-morph'
import type { JSDocableNode } from 'ts-morph'

export interface ExtractedFunction {
  name: string
  signature: string
  description: string | null
  isClass: boolean
}

export interface ExtractedModule {
  path: string
  functions: ExtractedFunction[]
  imports: string[]
}

export interface ExtractedDomain {
  name: string
  modules: ExtractedModule[]
}

export interface ExtractedProject {
  name: string
  domains: ExtractedDomain[]
}

const defaultIsInRepoImport = (specifier: string) => specifier.startsWith('.')

export interface ExtractOptions {
  /** Absolute directory whose files are documented; files outside it are skipped. */
  rootDir: string
  /** Prefix for module paths in the output (e.g. `src`). */
  pathPrefix: string
  /** Groups a file, given its path relative to rootDir, into a domain page. */
  domainOf: (relPath: string) => string
  /** Which import specifiers count as in-repo interactions. Defaults to relative imports. */
  isInRepoImport?: (specifier: string) => boolean
}

export function extractArchitecture(
  project: Project,
  { rootDir, pathPrefix, domainOf, isInRepoImport = defaultIsInRepoImport }: ExtractOptions,
): ExtractedDomain[] {
  const modulesByDomain = new Map<string, ExtractedModule[]>()

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath()
    const relToRoot = path.posix.relative(rootDir.split(path.sep).join('/'), filePath)
    if (relToRoot.startsWith('..')) continue
    if (/\.test\.tsx?$/.test(relToRoot)) continue

    const functions = extractFunctions(sourceFile)
    if (functions.length === 0) continue

    const imports = sourceFile
      .getImportDeclarations()
      .map((imp) => imp.getModuleSpecifierValue())
      .filter(isInRepoImport)
      .sort()

    const modulePath = `${pathPrefix}/${relToRoot}`
    const domainName = domainOf(relToRoot)
    const list = modulesByDomain.get(domainName) ?? []
    list.push({ path: modulePath, functions, imports: [...new Set(imports)] })
    modulesByDomain.set(domainName, list)
  }

  return [...modulesByDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, modules]) => ({
      name,
      modules: modules.sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

function extractFunctions(sourceFile: ReturnType<Project['getSourceFiles']>[number]): ExtractedFunction[] {
  const results: ExtractedFunction[] = []
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const decl of declarations) {
      const isClass = Node.isClassDeclaration(decl)
      const isFunctionLike =
        Node.isFunctionDeclaration(decl) || (Node.isVariableDeclaration(decl) && isFunctionInitializer(decl))

      if (!isClass && !isFunctionLike) continue

      results.push({
        name,
        signature: buildSignature(name, decl),
        description: getJsDocDescription(decl),
        isClass,
      })
    }
  }
  return results
}

function isFunctionInitializer(decl: Node): boolean {
  if (!Node.isVariableDeclaration(decl)) return false
  const init = decl.getInitializer()
  return init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
}

function buildSignature(name: string, decl: Node): string {
  if (Node.isClassDeclaration(decl)) return `class ${name}`

  let fn: Node | undefined
  if (Node.isFunctionDeclaration(decl)) fn = decl
  else if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer()
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) fn = init
  }
  if (!fn || !Node.isFunctionLikeDeclaration(fn)) return name

  const params = fn
    .getParameters()
    .map((p) => p.getText())
    .join(', ')
  const returnTypeNode = fn.getReturnTypeNode()
  const returnType = returnTypeNode ? returnTypeNode.getText() : withoutImportPaths(fn.getReturnType().getText())
  return oneLine(`${name}(${params}): ${returnType}`)
}

// Inferred types print as import("/abs/path").Name; the path differs per machine,
// which would make the committed docs drift between laptop and CI.
function withoutImportPaths(typeText: string): string {
  return typeText.replace(/import\("[^"]*"\)\./g, '')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function getJsDocDescription(decl: Node): string | null {
  let jsDocs: ReturnType<JSDocableNode['getJsDocs']> = []
  if (Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl)) {
    jsDocs = decl.getJsDocs()
  } else if (Node.isVariableDeclaration(decl)) {
    const list = decl.getParent()
    const stmt = Node.isVariableDeclarationList(list) ? list.getParent() : undefined
    if (stmt && Node.isVariableStatement(stmt)) jsDocs = stmt.getJsDocs()
  }
  const description = jsDocs[0]?.getDescription().trim()
  return description ? description : null
}

export function slugify(domainName: string): string {
  return domainName.replace(/\//g, '-')
}

// Every domain page starts its body with this line; writeSite only deletes pages carrying it,
// so hand-written pages in docs-site/ survive.
const GENERATED_MARKER = '_Generated by `scripts/gen-arch-doc.ts`'

export function renderDomainMarkdown(projectName: string, domain: ExtractedDomain): string {
  const lines: string[] = [
    `# ${domain.name}`,
    '',
    `${GENERATED_MARKER} — do not hand-edit. Part of the \`${projectName}\` project._`,
    '',
  ]

  for (const module of domain.modules) {
    lines.push(`## ${module.path}`, '')
    if (module.imports.length > 0) {
      lines.push(`**Interactions:** imports ${module.imports.map((i) => `\`${i}\``).join(', ')}`, '')
    }
    for (const fn of module.functions) {
      lines.push(`### \`${fn.signature}\``, '')
      lines.push(fn.description ?? '_(undocumented)_', '')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

export function renderProjectIndexMarkdown(project: ExtractedProject): string {
  const lines: string[] = [`# ${project.name}`, '']
  for (const domain of project.domains) {
    lines.push(`- [${domain.name}](./${slugify(domain.name)}.md)`)
  }
  return lines.join('\n').trimEnd() + '\n'
}

interface SiteManifest {
  projects: { name: string; domains: { name: string; slug: string }[] }[]
}

export function buildManifest(projects: ExtractedProject[]): SiteManifest {
  return {
    projects: projects.map((p) => ({
      name: p.name,
      domains: p.domains.map((d) => ({ name: d.name, slug: slugify(d.name) })),
    })),
  }
}

export function writeSite(projects: ExtractedProject[], outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(buildManifest(projects), null, 2) + '\n')

  const indexLines = ['# Architecture', '', 'Auto-generated map of this app. Pick a project:', '']
  for (const project of projects) {
    const projectDir = path.join(outDir, project.name)
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'index.md'), renderProjectIndexMarkdown(project))
    const pages = new Set(project.domains.map((d) => `${slugify(d.name)}.md`))
    for (const domain of project.domains) {
      fs.writeFileSync(path.join(projectDir, `${slugify(domain.name)}.md`), renderDomainMarkdown(project.name, domain))
    }
    removeStaleGeneratedPages(projectDir, pages)
    indexLines.push(`- [${project.name}](./${project.name}/index.md)`)
  }
  fs.writeFileSync(path.join(outDir, 'index.md'), indexLines.join('\n').trimEnd() + '\n')
}

function removeStaleGeneratedPages(projectDir: string, currentPages: Set<string>): void {
  for (const file of fs.readdirSync(projectDir)) {
    if (!file.endsWith('.md') || file === 'index.md' || currentPages.has(file)) continue
    const filePath = path.join(projectDir, file)
    if (fs.readFileSync(filePath, 'utf-8').includes(GENERATED_MARKER)) fs.rmSync(filePath)
  }
}

/**
 * Throws when a dependency in packageDir's package.json is missing from its node_modules.
 * Without them ts-morph silently resolves types to `any`, so the output differs from CI.
 */
export function assertDepsInstalled(packageDir: string, installCommand: string): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    (name) => !fs.existsSync(path.join(packageDir, 'node_modules', name)),
  )
  if (missing.length === 0) return
  throw new Error(
    `Missing dependencies in ${packageDir}: ${missing.join(', ')}. Run \`${installCommand}\` and retry; ` +
      'without them the generated docs differ from CI.',
  )
}

async function main() {
  const repoRoot = process.cwd()
  assertDepsInstalled(repoRoot, 'pnpm install')
  assertDepsInstalled(path.join(repoRoot, 'dashboard'), 'pnpm --dir dashboard install')

  const srcProject = new Project({ tsConfigFilePath: path.join(repoRoot, 'tsconfig.json') })
  const serverProject = new Project({ tsConfigFilePath: path.join(repoRoot, 'server/tsconfig.json') })
  const dashboardProject = new Project({ tsConfigFilePath: path.join(repoRoot, 'dashboard/tsconfig.json') })

  const projects: ExtractedProject[] = [
    {
      name: 'src',
      domains: extractArchitecture(srcProject, {
        rootDir: path.join(repoRoot, 'src'),
        pathPrefix: 'src',
        domainOf: (relPath) => relPath.split('/')[0],
      }),
    },
    {
      name: 'server',
      domains: extractArchitecture(serverProject, {
        rootDir: path.join(repoRoot, 'server'),
        pathPrefix: 'server',
        domainOf: () => 'server',
      }),
    },
    {
      name: 'dashboard',
      domains: extractArchitecture(dashboardProject, {
        rootDir: path.join(repoRoot, 'dashboard/src'),
        pathPrefix: 'dashboard/src',
        domainOf: (relPath) => {
          const segments = relPath.split('/')
          return segments[0] === 'app' && segments.length > 2 ? `${segments[0]}/${segments[1]}` : segments[0]
        },
        isInRepoImport: (spec) => spec.startsWith('.') || spec.startsWith('@/'),
      }),
    },
  ]

  writeSite(projects, path.join(repoRoot, 'docs-site'))

  const undocumented = projects
    .flatMap((p) => p.domains)
    .flatMap((d) => d.modules)
    .flatMap((m) => m.functions)
    .filter((f) => f.description === null).length
  console.log(`docs-site/ written. ${undocumented} undocumented function(s)/class(es).`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
