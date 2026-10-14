// Browser-facing /api paths that the VPS server answers itself. proxy.ts
// rewrites them there (adding the bearer key), so the browser keeps calling
// same-origin /api/* and never sees the key. A feature is added here when its
// Next route handlers are deleted, one line per migrated resource.
const SERVER_ROUTES = ['/api/settings', '/api/collect-keywords']

/**
 * The server URL a browser request should be rewritten to, or null when Next
 * still serves the path itself. `/api/settings` becomes `{baseUrl}/settings`.
 */
export function serverRouteTarget(pathname: string, search: string, baseUrl: string): URL | null {
  const matches = SERVER_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
  if (!matches) return null
  return new URL(`${baseUrl.replace(/\/+$/, '')}${pathname.slice('/api'.length)}${search}`)
}
