import { SocksClient } from 'socks'

export type SocksConnect = (opts: {
  host: string
  port: number
  destination: { host: string; port: number }
  timeoutMs: number
}) => Promise<{ destroy: () => void }>

export const defaultSocksConnect: SocksConnect = async ({ host, port, destination, timeoutMs }) => {
  const { socket } = await SocksClient.createConnection({
    proxy: { host, port, type: 5 },
    command: 'connect',
    destination,
    timeout: timeoutMs,
  })
  return socket
}

// Confirms the full path is actually usable — not just that the local SOCKS5
// port is open (a stale/half-dead SSH session can leave that true) — by
// relaying a real TCP connect through it to Facebook's own edge.
export async function checkTunnelAlive(
  proxyUrl: string,
  options: {
    timeoutMs?: number
    destination?: { host: string; port: number }
    connect?: SocksConnect
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5000
  const destination = options.destination ?? { host: 'www.facebook.com', port: 443 }
  const connect = options.connect ?? defaultSocksConnect
  const url = new URL(proxyUrl)

  try {
    const socket = await connect({ host: url.hostname, port: Number(url.port), destination, timeoutMs })
    socket.destroy()
    return true
  } catch {
    return false
  }
}
