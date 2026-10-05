import { resolveProxy, createDefaultProxyChecker } from './proxy'

const ORIGINAL_WEBSHARE = process.env.WEBSHARE_PROXY
const ORIGINAL_SOCKS = process.env.SOCKS_PROXY

afterEach(() => {
  if (ORIGINAL_WEBSHARE === undefined) delete process.env.WEBSHARE_PROXY
  else process.env.WEBSHARE_PROXY = ORIGINAL_WEBSHARE
  if (ORIGINAL_SOCKS === undefined) delete process.env.SOCKS_PROXY
  else process.env.SOCKS_PROXY = ORIGINAL_SOCKS
})

test('uses webshare when it is configured and reachable, without even checking the tunnel', async () => {
  process.env.WEBSHARE_PROXY = 'socks5://myuser:mypass@p.webshare.io:1080'
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checked: string[] = []
  const checker = async (url: string) => {
    checked.push(url)
    return url === process.env.WEBSHARE_PROXY
  }

  const result = await resolveProxy(process.env, checker)

  expect(result).toEqual({
    ok: true,
    proxy: {
      server: 'socks5://p.webshare.io:1080',
      username: 'myuser',
      password: 'mypass',
      source: 'webshare',
    },
  })
  expect(checked).toEqual(['socks5://myuser:mypass@p.webshare.io:1080'])
})

test('falls back to the tunnel when webshare is configured but unreachable', async () => {
  process.env.WEBSHARE_PROXY = 'socks5://myuser:mypass@p.webshare.io:1080'
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async (url: string) => url === process.env.SOCKS_PROXY

  const result = await resolveProxy(process.env, checker)

  expect(result).toEqual({
    ok: true,
    proxy: { server: 'socks5://127.0.0.1:1080', username: undefined, password: undefined, source: 'tunnel' },
  })
})

test('goes straight to the tunnel when webshare is not configured at all', async () => {
  delete process.env.WEBSHARE_PROXY
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checked: string[] = []
  const checker = async (url: string) => {
    checked.push(url)
    return true
  }

  const result = await resolveProxy(process.env, checker)

  expect(result.ok).toBe(true)
  expect(result.proxy?.source).toBe('tunnel')
  expect(checked).toEqual(['socks5://127.0.0.1:1080'])
})

test('fails closed when neither webshare nor the tunnel is configured', async () => {
  delete process.env.WEBSHARE_PROXY
  delete process.env.SOCKS_PROXY
  const checker = async () => true

  const result = await resolveProxy(process.env, checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('not configured')
})

test('fails closed when webshare is unreachable and no tunnel fallback is configured', async () => {
  process.env.WEBSHARE_PROXY = 'socks5://myuser:mypass@p.webshare.io:1080'
  delete process.env.SOCKS_PROXY
  const checker = async () => false

  const result = await resolveProxy(process.env, checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('WEBSHARE_PROXY')
})

test('the default checker dispatches socks5:// URLs to the SOCKS5 checker and http(s):// URLs to the HTTP CONNECT checker', async () => {
  const calls: string[] = []
  const checker = createDefaultProxyChecker({
    socks5: async (url) => {
      calls.push(`socks5:${url}`)
      return true
    },
    http: async (url) => {
      calls.push(`http:${url}`)
      return true
    },
  })

  await checker('socks5://127.0.0.1:1080')
  await checker('http://p.webshare.io:80')
  await checker('https://p.webshare.io:443')

  expect(calls).toEqual([
    'socks5:socks5://127.0.0.1:1080',
    'http:http://p.webshare.io:80',
    'http:https://p.webshare.io:443',
  ])
})

test('fails closed when webshare is unreachable and the tunnel fallback is also unreachable', async () => {
  process.env.WEBSHARE_PROXY = 'socks5://myuser:mypass@p.webshare.io:1080'
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async () => false

  const result = await resolveProxy(process.env, checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain("isn't reachable")
})
