import { collectKeywordsSchema } from './schemas'

function errorOf(input: unknown): string | undefined {
  const result = collectKeywordsSchema.safeParse(input)
  return result.success ? undefined : result.error.issues[0].message
}

test('collectKeywordsSchema trims and lowercases keywords and keeps their enabled flags', () => {
  const result = collectKeywordsSchema.safeParse([
    { keyword: '  iPhone ', enabled: true },
    { keyword: 'Laptop', enabled: false },
  ])

  expect(result).toEqual({
    success: true,
    data: [
      { keyword: 'iphone', enabled: true },
      { keyword: 'laptop', enabled: false },
    ],
  })
})

test('collectKeywordsSchema drops a repeated keyword, keeping the first occurrence', () => {
  const result = collectKeywordsSchema.safeParse([
    { keyword: 'phone', enabled: true },
    { keyword: ' PHONE', enabled: false },
  ])

  expect(result).toEqual({ success: true, data: [{ keyword: 'phone', enabled: true }] })
})

test('collectKeywordsSchema rejects anything that is not a non-empty array', () => {
  expect(errorOf(undefined)).toBe('keywords must be a non-empty array')
  expect(errorOf({})).toBe('keywords must be a non-empty array')
  expect(errorOf([])).toBe('keywords must be a non-empty array')
})

test('collectKeywordsSchema rejects an entry that is not { keyword: string, enabled: boolean }', () => {
  const message = 'each keyword must be { keyword: string, enabled: boolean }'

  expect(errorOf([{ keyword: 'phone' }])).toBe(message)
  expect(errorOf([{ keyword: 7, enabled: true }])).toBe(message)
  expect(errorOf([null])).toBe(message)
})

test('collectKeywordsSchema rejects a blank keyword', () => {
  expect(errorOf([{ keyword: '   ', enabled: true }])).toBe('keyword cannot be blank')
})

test('collectKeywordsSchema rejects a list with every keyword disabled', () => {
  expect(errorOf([{ keyword: 'phone', enabled: false }])).toBe('at least one keyword must be enabled')
})
