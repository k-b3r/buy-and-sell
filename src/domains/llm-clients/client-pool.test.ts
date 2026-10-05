import { createClientPool } from './client-pool'

interface Fake {
  name: string
  call(): Promise<string>
}

const quota = () => Object.assign(new Error('quota'), { status: 429 })

function fake(name: string, outcomes: ('ok' | 'quota' | 'boom')[], calls: string[]): Fake {
  let i = 0
  return {
    name,
    async call() {
      calls.push(name)
      const outcome = outcomes[Math.min(i++, outcomes.length - 1)]
      if (outcome === 'quota') throw quota()
      if (outcome === 'boom') throw new Error(`${name} boom`)
      return name
    },
  }
}

test('a sticky pool uses the first client until it is exhausted, then switches permanently to the next', async () => {
  const calls: string[] = []
  const run = createClientPool([fake('a', ['ok', 'quota'], calls), fake('b', ['ok'], calls)], { provider: 'Test' })
  expect(await run((c) => c.call())).toBe('a')
  expect(await run((c) => c.call())).toBe('b')
  expect(await run((c) => c.call())).toBe('b')
  expect(calls).toEqual(['a', 'a', 'b', 'b'])
})

test('a round-robin pool rotates across clients on every successful call', async () => {
  const calls: string[] = []
  const run = createClientPool([fake('a', ['ok'], calls), fake('b', ['ok'], calls), fake('c', ['ok'], calls)], {
    provider: 'Test',
    strategy: 'round-robin',
  })
  for (let i = 0; i < 4; i++) await run((c) => c.call())
  expect(calls).toEqual(['a', 'b', 'c', 'a'])
})

test('a round-robin pool drops an exhausted client for good and keeps rotating the rest', async () => {
  const calls: string[] = []
  const run = createClientPool([fake('a', ['ok'], calls), fake('b', ['quota'], calls), fake('c', ['ok'], calls)], {
    provider: 'Test',
    strategy: 'round-robin',
  })
  for (let i = 0; i < 4; i++) await run((c) => c.call())
  expect(calls).toEqual(['a', 'b', 'c', 'a', 'c'])
})

test('a pool rethrows a non-exhaustion error without switching clients', async () => {
  const calls: string[] = []
  const run = createClientPool([fake('a', ['boom', 'ok'], calls), fake('b', ['ok'], calls)], { provider: 'Test' })
  await expect(run((c) => c.call())).rejects.toThrow('a boom')
  expect(await run((c) => c.call())).toBe('a')
  expect(calls).toEqual(['a', 'a'])
})

test('a pool rethrows the exhaustion error once its last client is exhausted too', async () => {
  const calls: string[] = []
  const run = createClientPool([fake('a', ['quota'], calls), fake('b', ['quota'], calls)], { provider: 'Test' })
  await expect(run((c) => c.call())).rejects.toMatchObject({ status: 429 })
  await expect(run((c) => c.call())).rejects.toMatchObject({ status: 429 })
  expect(calls).toEqual(['a', 'b', 'b'])
})

test('a pool fires onFallback with the from/to labels the moment it drops a client', async () => {
  const events: [string, string][] = []
  const run = createClientPool([fake('a', ['quota'], []), fake('b', ['ok'], [])], {
    provider: 'Test',
    labels: ['KEY0', 'KEY1'],
    onFallback: (from, to) => events.push([from, to]),
  })
  await run((c) => c.call())
  expect(events).toEqual([['KEY0', 'KEY1']])
})

test('a pool labels clients by index when no labels are given', async () => {
  const events: [string, string][] = []
  const run = createClientPool([fake('a', ['quota'], []), fake('b', ['ok'], [])], {
    provider: 'Test',
    onFallback: (from, to) => events.push([from, to]),
  })
  await run((c) => c.call())
  expect(events).toEqual([['client 0', 'client 1']])
})

test('a pool switches on whatever the provider counts as exhaustion', async () => {
  const calls: string[] = []
  const credits = {
    name: 'a',
    call: async () => Promise.reject(Object.assign(new Error('no credits'), { status: 402 })),
  }
  const run = createClientPool([credits, fake('b', ['ok'], calls)], {
    provider: 'Test',
    isExhausted: (err) => (err as { status?: unknown }).status === 402,
  })
  expect(await run((c) => c.call())).toBe('b')
})

test('an empty pool fails with a message naming the provider', async () => {
  const run = createClientPool<Fake>([], { provider: 'Groq' })
  await expect(run((c) => c.call())).rejects.toThrow('all Groq clients exhausted')
})
