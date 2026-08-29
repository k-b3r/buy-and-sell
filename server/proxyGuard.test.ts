import { checkProxyBeforeLaunch } from './proxyGuard'

const ORIGINAL_SOCKS = process.env.SOCKS_PROXY
const ORIGINAL_WEBSHARE = process.env.WEBSHARE_PROXY
const ORIGINAL_SKIP = process.env.SKIP_TUNNEL_CHECK

afterEach(() => {
  if (ORIGINAL_SOCKS === undefined) delete process.env.SOCKS_PROXY
  else process.env.SOCKS_PROXY = ORIGINAL_SOCKS
  if (ORIGINAL_WEBSHARE === undefined) delete process.env.WEBSHARE_PROXY
  else process.env.WEBSHARE_PROXY = ORIGINAL_WEBSHARE
  if (ORIGINAL_SKIP === undefined) delete process.env.SKIP_TUNNEL_CHECK
  else process.env.SKIP_TUNNEL_CHECK = ORIGINAL_SKIP
})

test('fails closed when neither WEBSHARE_PROXY nor SOCKS_PROXY is configured', async () => {
  delete process.env.WEBSHARE_PROXY
  delete process.env.SOCKS_PROXY
  const checker = async () => true // would say alive, but never even called

  const result = await checkProxyBeforeLaunch(checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('not configured')
})

test('fails closed when SOCKS_PROXY is set but the tunnel is not actually reachable', async () => {
  delete process.env.WEBSHARE_PROXY
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async () => false

  const result = await checkProxyBeforeLaunch(checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('socks5://127.0.0.1:1080')
  expect(result.error).toContain("isn't reachable")
})

test('passes and returns the tunnel proxy config when SOCKS_PROXY relays successfully', async () => {
  delete process.env.WEBSHARE_PROXY
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async (proxyUrl: string) => proxyUrl === 'socks5://127.0.0.1:1080'

  const result = await checkProxyBeforeLaunch(checker)

  expect(result).toEqual({
    ok: true,
    proxy: { server: 'socks5://127.0.0.1:1080', username: undefined, password: undefined, source: 'tunnel' },
  })
})

test('prefers WEBSHARE_PROXY over the tunnel when it is reachable', async () => {
  process.env.WEBSHARE_PROXY = 'socks5://myuser:mypass@p.webshare.io:1080'
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async (proxyUrl: string) => proxyUrl === process.env.WEBSHARE_PROXY

  const result = await checkProxyBeforeLaunch(checker)

  expect(result).toEqual({
    ok: true,
    proxy: {
      server: 'socks5://p.webshare.io:1080',
      username: 'myuser',
      password: 'mypass',
      source: 'webshare',
    },
  })
})

test('SKIP_TUNNEL_CHECK bypasses the proxy requirement entirely - never even calls the checker', async () => {
  delete process.env.WEBSHARE_PROXY
  delete process.env.SOCKS_PROXY
  process.env.SKIP_TUNNEL_CHECK = 'true'
  const checker = async () => {
    throw new Error('should never be called when bypassed')
  }

  const result = await checkProxyBeforeLaunch(checker)

  expect(result).toEqual({ ok: true })
})

test('a SKIP_TUNNEL_CHECK value other than exactly "true" does not bypass', async () => {
  delete process.env.WEBSHARE_PROXY
  delete process.env.SOCKS_PROXY
  process.env.SKIP_TUNNEL_CHECK = '1'
  const checker = async () => true

  const result = await checkProxyBeforeLaunch(checker)

  expect(result.ok).toBe(false)
})
