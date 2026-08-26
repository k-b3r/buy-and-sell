import type { SocksConnect } from './tunnel'
import { checkTunnelAlive } from './tunnel'

test('returns true when the proxy relays a real connection through', async () => {
  const connect: SocksConnect = async () => ({ destroy: () => {} })

  expect(await checkTunnelAlive('socks5://127.0.0.1:1080', { connect })).toBe(true)
})

test('returns false instead of throwing when the tunnel refuses the connection', async () => {
  const connect: SocksConnect = async () => {
    throw new Error('ECONNREFUSED')
  }

  expect(await checkTunnelAlive('socks5://127.0.0.1:1080', { connect })).toBe(false)
})

test('returns false on timeout without throwing', async () => {
  const connect: SocksConnect = async () => {
    throw new Error('Proxy connection timed out')
  }

  expect(await checkTunnelAlive('socks5://127.0.0.1:1080', { connect, timeoutMs: 100 })).toBe(false)
})

test('passes the parsed proxy host/port and destination through to connect', async () => {
  let received: Parameters<SocksConnect>[0] | undefined
  const connect: SocksConnect = async (opts) => {
    received = opts
    return { destroy: () => {} }
  }

  await checkTunnelAlive('socks5://127.0.0.1:1080', {
    connect,
    destination: { host: 'www.facebook.com', port: 443 },
  })

  expect(received).toEqual({
    host: '127.0.0.1',
    port: 1080,
    destination: { host: 'www.facebook.com', port: 443 },
    timeoutMs: 5000,
  })
})
