import { checkTunnelAlive } from './tunnel'
import { checkHttpProxyAlive } from './httpProxy'

export type ProxyChecker = (proxyUrl: string) => Promise<boolean>

// Webshare supports both protocols; SOCKS_PROXY (the ssh tunnel) is always
// socks5. Dispatch on scheme so WEBSHARE_PROXY can be either without the
// caller having to know which.
export function createDefaultProxyChecker(
  checkers: { socks5: ProxyChecker; http: ProxyChecker } = { socks5: checkTunnelAlive, http: checkHttpProxyAlive },
): ProxyChecker {
  return (proxyUrl) => (new URL(proxyUrl).protocol === 'socks5:' ? checkers.socks5(proxyUrl) : checkers.http(proxyUrl))
}

export const defaultProxyChecker = createDefaultProxyChecker()

export interface ResolvedProxy {
  server: string
  username?: string
  password?: string
  source: 'webshare' | 'tunnel'
}

export interface ProxyResolution {
  ok: boolean
  error?: string
  proxy?: ResolvedProxy
}

function toResolvedProxy(proxyUrl: string, source: ResolvedProxy['source']): ResolvedProxy {
  const url = new URL(proxyUrl)
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username || undefined,
    password: url.password || undefined,
    source,
  }
}

// Webshare's rotating residential proxy first (many exit IPs, no single
// point of failure) - falls back to the laptop-relayed SOCKS tunnel
// (scripts/tunnel.sh) exactly as before if Webshare is unset or unreachable.
// Fails closed if neither works, same contract collect/check-listings/the
// server guard already relied on for SOCKS_PROXY alone.
export interface ProxyEnv {
  WEBSHARE_PROXY?: string
  SOCKS_PROXY?: string
}

export async function resolveProxy(
  env: ProxyEnv,
  checker: ProxyChecker = defaultProxyChecker,
): Promise<ProxyResolution> {
  const webshareProxy = env.WEBSHARE_PROXY
  if (webshareProxy && (await checker(webshareProxy))) {
    return { ok: true, proxy: toResolvedProxy(webshareProxy, 'webshare') }
  }

  const socksProxy = env.SOCKS_PROXY
  if (!socksProxy) {
    return {
      ok: false,
      error: webshareProxy
        ? `WEBSHARE_PROXY (${webshareProxy}) is unreachable and SOCKS_PROXY fallback is not configured`
        : "SOCKS_PROXY is not configured (and WEBSHARE_PROXY isn't set either) - refusing to hit Facebook directly from this box",
    }
  }

  if (!(await checker(socksProxy))) {
    return {
      ok: false,
      error: `SOCKS_PROXY is set to ${socksProxy} but the tunnel isn't reachable — start the laptop-side ssh -R tunnel`,
    }
  }

  return { ok: true, proxy: toResolvedProxy(socksProxy, 'tunnel') }
}
