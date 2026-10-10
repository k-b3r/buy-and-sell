import { parseReasonsFlag } from './args'

test('parseReasonsFlag returns undefined when the flag is absent, meaning every reason', () => {
  expect(parseReasonsFlag(['--apply', '--min-confidence', 'high'])).toBeUndefined()
})

test('parseReasonsFlag splits a comma list and trims empties', () => {
  expect(parseReasonsFlag(['--apply', '--reasons', 'retail_not_found,exa_no_result'])).toEqual([
    'retail_not_found',
    'exa_no_result',
  ])
  expect(parseReasonsFlag(['--reasons', 'a,,b,'])).toEqual(['a', 'b'])
})

test('parseReasonsFlag refuses a --reasons with no value, so a typo cannot widen the run', () => {
  expect(() => parseReasonsFlag(['--apply', '--reasons'])).toThrow('--reasons needs')
  expect(() => parseReasonsFlag(['--reasons', '--min-confidence', 'high'])).toThrow('--reasons needs')
  expect(() => parseReasonsFlag(['--reasons', ','])).toThrow('--reasons needs')
})
