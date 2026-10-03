import { defaultProxyChecker, resolveProxy, type ProxyChecker, type ResolvedProxy } from '../src/domains/marketplace'

export type TunnelChecker = ProxyChecker

export interface TunnelCheckResult {
  ok: boolean
  error?: string
  proxy?: ResolvedProxy
}

// Every browser launch on this server must route through a residential IP -
// Webshare's rotating proxy first, the laptop-relayed SOCKS5 tunnel as
// fallback (see src/domains/marketplace/proxy.ts) - same as the CLI's
// collect/check-listings. Facebook walls Hetzner's datacenter IP immediately
// (see src/tunnel.ts's originating commit for the confirmed finding). Fails
// closed rather than falling back to a direct launch: confirmed live
// 2026-08-24, a listing refreshed directly from Hetzner's IP got soft-walled
// twice 99 minutes apart and was hard-deleted - genuinely still live on
// Facebook the whole time. No time gap fixes that; only actually not hitting
// Facebook from the walled IP does.
// Explicit, opt-in-only escape hatch for local dev - a laptop running
// server/ directly already browses from its own residential IP, so the
// datacenter-IP-walling problem this guard exists for doesn't apply. Must be
// set to exactly "true" in server/.env, and only ever locally - the VPS's
// own .env must never set this, or the guard this whole file exists for is
// gone there too.
export async function checkProxyBeforeLaunch(checker: TunnelChecker = defaultProxyChecker): Promise<TunnelCheckResult> {
  if (process.env.SKIP_TUNNEL_CHECK === 'true') {
    return { ok: true }
  }

  return resolveProxy(process.env, checker)
}
