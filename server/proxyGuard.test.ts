import { createProxyGuard } from './proxyGuard'

test('fails closed when neither WEBSHARE_PROXY nor SOCKS_PROXY is configured', async () => {
  const checker = async () => true // would say alive, but never even called

  const result = await createProxyGuard({}, checker)()

  expect(result.ok).toBe(false)
  expect(result.error).toContain('not configured')
})

test('fails closed when SOCKS_PROXY is set but the tunnel is not actually reachable', async () => {
  const checker = async () => false

  const result = await createProxyGuard({ SOCKS_PROXY: 'socks5://127.0.0.1:1080' }, checker)()

  expect(result.ok).toBe(false)
  expect(result.error).toContain('socks5://127.0.0.1:1080')
  expect(result.error).toContain("isn't reachable")
})

test('passes and returns the tunnel proxy config when SOCKS_PROXY relays successfully', async () => {
  const checker = async (proxyUrl: string) => proxyUrl === 'socks5://127.0.0.1:1080'

  const result = await createProxyGuard({ SOCKS_PROXY: 'socks5://127.0.0.1:1080' }, checker)()

  expect(result).toEqual({
    ok: true,
    proxy: { server: 'socks5://127.0.0.1:1080', username: undefined, password: undefined, source: 'tunnel' },
  })
})

test('prefers WEBSHARE_PROXY over the tunnel when it is reachable', async () => {
  const env = { WEBSHARE_PROXY: 'socks5://myuser:mypass@p.webshare.io:1080', SOCKS_PROXY: 'socks5://127.0.0.1:1080' }
  const checker = async (proxyUrl: string) => proxyUrl === env.WEBSHARE_PROXY

  const result = await createProxyGuard(env, checker)()

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
  const checker = async () => {
    throw new Error('should never be called when bypassed')
  }

  const result = await createProxyGuard({ SKIP_TUNNEL_CHECK: 'true' }, checker)()

  expect(result).toEqual({ ok: true })
})

test('a SKIP_TUNNEL_CHECK value other than exactly "true" does not bypass', async () => {
  const checker = async () => true

  const result = await createProxyGuard({ SKIP_TUNNEL_CHECK: '1' }, checker)()

  expect(result.ok).toBe(false)
})
