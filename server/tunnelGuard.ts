import { checkTunnelAlive } from '../src/tunnel'

export type TunnelChecker = (proxyUrl: string) => Promise<boolean>

export interface TunnelCheckResult {
  ok: boolean
  error?: string
}

// Every browser launch on this server must route through the laptop-relayed
// SOCKS5 tunnel, same as the CLI's collect/check-listings - Facebook walls
// Hetzner's datacenter IP immediately (see src/tunnel.ts's originating
// commit for the confirmed finding). Fails closed rather than falling back
// to a direct launch: confirmed live 2026-08-24, a listing refreshed
// directly from Hetzner's IP got soft-walled twice 99 minutes apart and was
// hard-deleted - genuinely still live on Facebook the whole time. No time
// gap fixes that; only actually not hitting Facebook from the walled IP does.
export async function checkTunnelBeforeLaunch(checker: TunnelChecker = checkTunnelAlive): Promise<TunnelCheckResult> {
  const socksProxy = process.env.SOCKS_PROXY
  if (!socksProxy) {
    return { ok: false, error: 'SOCKS_PROXY is not configured - refusing to hit Facebook directly from this box' }
  }

  const alive = await checker(socksProxy)
  if (!alive) {
    return {
      ok: false,
      error: `SOCKS_PROXY is set to ${socksProxy} but the tunnel isn't reachable — start the laptop-side ssh -R tunnel`,
    }
  }
  return { ok: true }
}
