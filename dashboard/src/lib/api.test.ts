import { expect, test, vi } from 'vitest'
import { api } from './api'

const ENV = { REFRESH_SERVER_URL: 'https://vps.test', REFRESH_API_KEY: 'test-key' }

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }))
}

test('api sends a GET with the bearer key to the server base url and returns the parsed body', async () => {
  const fetchFn = fakeFetch(200, { settings: [] })

  const result = await api<{ settings: unknown[] }>('/settings', {}, { env: ENV, fetch: fetchFn })

  expect(result).toEqual({ settings: [] })
  const [url, init] = fetchFn.mock.calls[0]
  expect(url).toBe('https://vps.test/settings')
  expect(init.method).toBe('GET')
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
  expect(init.body).toBeUndefined()
  expect(init.cache).toBe('no-store')
})

test('api sends a JSON body with the given method', async () => {
  const fetchFn = fakeFetch(200, { ok: true })

  await api('/settings', { method: 'PATCH', body: { updates: [{ key: 'a', value: 1 }] } }, { env: ENV, fetch: fetchFn })

  const [, init] = fetchFn.mock.calls[0]
  expect(init.method).toBe('PATCH')
  expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
  expect(JSON.parse(init.body as string)).toEqual({ updates: [{ key: 'a', value: 1 }] })
})

test('api tolerates a trailing slash on the base url', async () => {
  const fetchFn = fakeFetch(200, {})

  await api('/settings', {}, { env: { ...ENV, REFRESH_SERVER_URL: 'https://vps.test/' }, fetch: fetchFn })

  expect(fetchFn.mock.calls[0][0]).toBe('https://vps.test/settings')
})

test('api throws with the path and status on a non-ok response', async () => {
  const fetchFn = fakeFetch(500, { error: 'internal error' })

  await expect(api('/settings', {}, { env: ENV, fetch: fetchFn })).rejects.toThrow('GET /settings failed: 500')
})

test('api throws when the server url or key is not configured', async () => {
  const fetchFn = fakeFetch(200, {})

  await expect(api('/settings', {}, { env: { REFRESH_API_KEY: 'test-key' }, fetch: fetchFn })).rejects.toThrow(
    'REFRESH_SERVER_URL/REFRESH_API_KEY not set',
  )
  expect(fetchFn).not.toHaveBeenCalled()
})
