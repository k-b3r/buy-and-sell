import { connect as netConnect } from 'node:net'

export type HttpConnect = (opts: {
  host: string
  port: number
  destination: { host: string; port: number }
  timeoutMs: number
  username?: string
  password?: string
}) => Promise<{ destroy: () => void }>

// Raw HTTP CONNECT tunnel - no proxy-agent dependency needed for a single
// reachability probe. Mirrors tunnel.ts's SOCKS5 check: relay a real CONNECT
// through the proxy to Facebook's own edge, not just confirm the port is open.
const defaultHttpConnect: HttpConnect = ({ host, port, destination, timeoutMs, username, password }) => {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('proxy CONNECT timed out'))
    }, timeoutMs)

    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    socket.once('connect', () => {
      const auth =
        username !== undefined
          ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}\r\n`
          : ''
      socket.write(
        `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\nHost: ${destination.host}:${destination.port}\r\n${auth}\r\n`,
      )
    })

    socket.once('data', (chunk) => {
      clearTimeout(timer)
      const statusLine = chunk.toString('utf8').split('\r\n')[0]
      if (/^HTTP\/1\.[01] 200/.test(statusLine)) {
        resolve({ destroy: () => socket.destroy() })
      } else {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed: ${statusLine}`))
      }
    })
  })
}

export async function checkHttpProxyAlive(
  proxyUrl: string,
  options: {
    timeoutMs?: number
    destination?: { host: string; port: number }
    connect?: HttpConnect
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5000
  const destination = options.destination ?? { host: 'www.facebook.com', port: 443 }
  const connect = options.connect ?? defaultHttpConnect
  const url = new URL(proxyUrl)

  // WHATWG URL drops the port entirely when it matches the scheme's default
  // (http -> 80, https -> 443) - url.port is '' for "http://host:80", so
  // Number('') would silently become 0 instead of 80.
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80

  try {
    const socket = await connect({
      host: url.hostname,
      port,
      destination,
      timeoutMs,
      username: url.username || undefined,
      password: url.password || undefined,
    })
    socket.destroy()
    return true
  } catch {
    return false
  }
}
