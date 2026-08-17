import { Readable, Writable } from 'node:stream'
import { promptReview } from '../src/review'

function mockInput(...lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n').join(''))
}

function mockOutput(): { stream: Writable; text: () => string } {
  let text = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString()
      cb()
    },
  })
  return { stream, text: () => text }
}

test('"y" resolves to approve', async () => {
  const out = mockOutput()
  const decision = await promptReview({ id: '1', title: 'Mic' }, mockInput('y'), out.stream)
  expect(decision).toBe('approve')
  expect(out.text()).toContain('title')
})

test('"n" resolves to reject', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('n'), mockOutput().stream)
  expect(decision).toBe('reject')
})

test('"s" resolves to stop', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('s'), mockOutput().stream)
  expect(decision).toBe('stop')
})

test('invalid input re-prompts until valid', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('bogus', 'y'), mockOutput().stream)
  expect(decision).toBe('approve')
})
