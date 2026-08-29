import type { HttpConnect } from './httpProxy'
import { checkHttpProxyAlive } from './httpProxy'

test('returns true when the proxy CONNECTs through successfully', async () => {
  const connect: HttpConnect = async () => ({ destroy: () => {} })

  expect(await checkHttpProxyAlive('http://p.webshare.io:80', { connect })).toBe(true)
})

test('returns false instead of throwing when the CONNECT is refused', async () => {
  const connect: HttpConnect = async () => {
    throw new Error('proxy CONNECT failed: HTTP/1.1 407 Proxy Authentication Required')
  }

  expect(await checkHttpProxyAlive('http://p.webshare.io:80', { connect })).toBe(false)
})

test('returns false on timeout without throwing', async () => {
  const connect: HttpConnect = async () => {
    throw new Error('timeout')
  }

  expect(await checkHttpProxyAlive('http://p.webshare.io:80', { connect, timeoutMs: 100 })).toBe(false)
})

test('passes the parsed proxy host/port, credentials, and destination through to connect', async () => {
  let received: Parameters<HttpConnect>[0] | undefined
  const connect: HttpConnect = async (opts) => {
    received = opts
    return { destroy: () => {} }
  }

  await checkHttpProxyAlive('http://myuser:mypass@p.webshare.io:80', {
    connect,
    destination: { host: 'www.facebook.com', port: 443 },
  })

  expect(received).toEqual({
    host: 'p.webshare.io',
    port: 80,
    destination: { host: 'www.facebook.com', port: 443 },
    timeoutMs: 5000,
    username: 'myuser',
    password: 'mypass',
  })
})

test('omits username/password when the proxy URL has no credentials', async () => {
  let received: Parameters<HttpConnect>[0] | undefined
  const connect: HttpConnect = async (opts) => {
    received = opts
    return { destroy: () => {} }
  }

  await checkHttpProxyAlive('http://p.webshare.io:80', { connect })

  expect(received?.username).toBeUndefined()
  expect(received?.password).toBeUndefined()
})
