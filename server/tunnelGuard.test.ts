import { checkTunnelBeforeLaunch } from '../tunnelGuard'

const ORIGINAL_ENV = process.env.SOCKS_PROXY
const ORIGINAL_SKIP = process.env.SKIP_TUNNEL_CHECK

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SOCKS_PROXY
  else process.env.SOCKS_PROXY = ORIGINAL_ENV
  if (ORIGINAL_SKIP === undefined) delete process.env.SKIP_TUNNEL_CHECK
  else process.env.SKIP_TUNNEL_CHECK = ORIGINAL_SKIP
})

test('fails closed when SOCKS_PROXY is not configured at all', async () => {
  delete process.env.SOCKS_PROXY
  const checker = async () => true // would say alive, but never even called

  const result = await checkTunnelBeforeLaunch(checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('not configured')
})

test('fails closed when SOCKS_PROXY is set but the tunnel is not actually reachable', async () => {
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async () => false

  const result = await checkTunnelBeforeLaunch(checker)

  expect(result.ok).toBe(false)
  expect(result.error).toContain('socks5://127.0.0.1:1080')
  expect(result.error).toContain("isn't reachable")
})

test('passes when SOCKS_PROXY is configured and the tunnel relays successfully', async () => {
  process.env.SOCKS_PROXY = 'socks5://127.0.0.1:1080'
  const checker = async (proxyUrl: string) => proxyUrl === 'socks5://127.0.0.1:1080'

  const result = await checkTunnelBeforeLaunch(checker)

  expect(result).toEqual({ ok: true })
})

test('SKIP_TUNNEL_CHECK bypasses the SOCKS_PROXY requirement entirely - never even calls the checker', async () => {
  delete process.env.SOCKS_PROXY
  process.env.SKIP_TUNNEL_CHECK = 'true'
  const checker = async () => {
    throw new Error('should never be called when bypassed')
  }

  const result = await checkTunnelBeforeLaunch(checker)

  expect(result).toEqual({ ok: true })
})

test('a SKIP_TUNNEL_CHECK value other than exactly "true" does not bypass', async () => {
  delete process.env.SOCKS_PROXY
  process.env.SKIP_TUNNEL_CHECK = '1'
  const checker = async () => true

  const result = await checkTunnelBeforeLaunch(checker)

  expect(result.ok).toBe(false)
})
