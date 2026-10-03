// Repo hygiene gates that no off-the-shelf linter fits:
//   commits <base>        commit subjects in <base>..HEAD follow CODING_STANDARDS.md
//   escape-hatches <base> eslint-disable / `as any` / @ts-expect-error count never grows
// commitlint was skipped: its parser expects a `type:` prefix this repo doesn't use.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_SUBJECT = 72
// Footer match is unanchored: Claude Code's footer starts with an emoji.
const ATTRIBUTION = /^co-authored-by:.*\b(claude|anthropic)\b|generated with \[?claude/im

export function checkCommitMessage(message: string): string[] {
  const subject = message.split('\n')[0]
  const problems: string[] = []
  if (!/^[a-z0-9]/.test(subject)) problems.push('subject must start lowercase')
  if (subject.endsWith('.')) problems.push('subject must not end with a period')
  if (subject.length > MAX_SUBJECT) problems.push(`subject must be at most ${MAX_SUBJECT} characters`)
  if (ATTRIBUTION.test(message)) problems.push('no AI attribution (Co-Authored-By / Generated with)')
  return problems
}

const HATCHES = {
  'eslint-disable': /eslint-disable/g,
  'as any': /\bas any\b/g,
  '@ts-expect-error': /@ts-expect-error/g,
} as const
type HatchCounts = Record<keyof typeof HATCHES, number>

export function countEscapeHatches(fileContents: string[]): HatchCounts {
  const counts = { 'eslint-disable': 0, 'as any': 0, '@ts-expect-error': 0 }
  for (const text of fileContents) {
    for (const [kind, pattern] of Object.entries(HATCHES) as [keyof HatchCounts, RegExp][]) {
      counts[kind] += text.match(pattern)?.length ?? 0
    }
  }
  return counts
}

export function escapeHatchGrowth(base: HatchCounts, head: HatchCounts): string[] {
  return (Object.keys(base) as (keyof HatchCounts)[])
    .filter((kind) => head[kind] > base[kind])
    .map((kind) => `${kind}: ${base[kind]} -> ${head[kind]}`)
}

const isSource = (p: string) => /\.tsx?$/.test(p)
// Lint fixtures and this script's own patterns contain escape hatches on purpose.
const isExempt = (p: string) => p.startsWith('tests/lint-fixtures/') || p.startsWith('scripts/repo-checks')

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function filesAt(ref: string): string[] {
  const paths = git('ls-tree', '-r', '--name-only', ref)
    .split('\n')
    .filter((p) => isSource(p) && !isExempt(p))
  return paths.map((p) => git('show', `${ref}:${p}`))
}

function main([command, base]: string[]): number {
  if (!base) {
    console.error('usage: repo-checks <commits|escape-hatches> <base-ref>')
    return 2
  }
  if (command === 'commits') {
    const shas = git('rev-list', '--no-merges', `${base}..HEAD`).split('\n').filter(Boolean)
    let failed = 0
    for (const sha of shas) {
      const problems = checkCommitMessage(git('log', '-1', '--format=%B', sha))
      if (problems.length) {
        failed++
        console.error(`${sha.slice(0, 7)} ${git('log', '-1', '--format=%s', sha).trim()}\n  ${problems.join('\n  ')}`)
      }
    }
    console.log(`${shas.length - failed}/${shas.length} commits ok`)
    return failed ? 1 : 0
  }
  if (command === 'escape-hatches') {
    const growth = escapeHatchGrowth(countEscapeHatches(filesAt(base)), countEscapeHatches(filesAt('HEAD')))
    if (growth.length) console.error(`escape hatches grew versus ${base}:\n  ${growth.join('\n  ')}`)
    else console.log(`escape hatches did not grow versus ${base}`)
    return growth.length ? 1 : 0
  }
  console.error(`unknown command: ${command}`)
  return 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
