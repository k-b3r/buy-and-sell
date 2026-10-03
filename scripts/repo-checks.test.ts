import { checkCommitMessage, countEscapeHatches, escapeHatchGrowth } from './repo-checks'

test('checkCommitMessage accepts an imperative lowercase subject', () => {
  expect(checkCommitMessage('add real estate page')).toEqual([])
})

test('checkCommitMessage accepts the merge <branch> style', () => {
  expect(checkCommitMessage('merge standards-and-test-setup')).toEqual([])
})

test('checkCommitMessage flags a capitalized subject', () => {
  expect(checkCommitMessage('Add real estate page')).toContain('subject must start lowercase')
})

test('checkCommitMessage flags a trailing period', () => {
  expect(checkCommitMessage('add real estate page.')).toContain('subject must not end with a period')
})

test('checkCommitMessage flags a subject longer than 72 characters', () => {
  expect(checkCommitMessage('add ' + 'x'.repeat(70))).toContain('subject must be at most 72 characters')
})

test('checkCommitMessage flags AI attribution trailers anywhere in the body', () => {
  const message = 'add page\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
  expect(checkCommitMessage(message)).toContain('no AI attribution (Co-Authored-By / Generated with)')
})

test('checkCommitMessage flags a Generated with line', () => {
  expect(checkCommitMessage('add page\n\nGenerated with Claude Code')).toContain(
    'no AI attribution (Co-Authored-By / Generated with)',
  )
})

test('checkCommitMessage flags the emoji-prefixed Claude Code footer', () => {
  const message = 'add page\n\nbody\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
  expect(checkCommitMessage(message)).toContain('no AI attribution (Co-Authored-By / Generated with)')
})

test('checkCommitMessage allows mentioning generated files in the body', () => {
  expect(checkCommitMessage('regenerate docs\n\nFiles generated with gen-arch-doc')).toEqual([])
})

test('countEscapeHatches counts each kind across files', () => {
  const files = [
    'const a = b as any\n// eslint-disable-next-line no-x -- reason\n',
    '// @ts-expect-error -- upstream types wrong\nconst c = d as any',
  ]
  expect(countEscapeHatches(files)).toEqual({ 'eslint-disable': 1, 'as any': 2, '@ts-expect-error': 1 })
})

test('escapeHatchGrowth reports only kinds that grew versus base', () => {
  const base = { 'eslint-disable': 14, 'as any': 0, '@ts-expect-error': 1 }
  const head = { 'eslint-disable': 15, 'as any': 0, '@ts-expect-error': 0 }
  expect(escapeHatchGrowth(base, head)).toEqual(['eslint-disable: 14 -> 15'])
})
