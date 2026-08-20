import { readFileSync } from 'node:fs'
import { detectPageState } from '../src/wall'

test('normal page with no wall markers', () => {
  const html = readFileSync('fixtures/normal-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('normal')
})

test('soft-wall page with login overlay', () => {
  const html = readFileSync('fixtures/soft-wall-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('soft-wall')
})

test('hard-block page with captcha/checkpoint', () => {
  const html = readFileSync('fixtures/hard-block-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('hard-block')
})

test('does not false-positive hard-block on a bare "recaptcha" JS component name with no actual widget present', () => {
  const html = readFileSync('fixtures/soft-wall-with-recaptcha-bundle-name.html', 'utf-8')
  expect(detectPageState(html)).toBe('soft-wall')
})
