// Browser-facing /api paths that the VPS server answers itself. proxy.ts
// rewrites them there (adding the bearer key), so the browser keeps calling
// same-origin /api/* and never sees the key. A feature is added here when its
// Next route handlers are deleted, one entry per migrated route.
//
// `pattern` is an exact path; `:name` matches exactly one non-empty segment
// (`/api/products/:id/listings`), so a migrated route never swallows its
// unmigrated siblings. By default the server path is `pattern` minus `/api`;
// `serverPath` overrides it and may reuse the pattern's `:name` params.
export interface ServerRoute {
  pattern: string
  serverPath?: string
}

const SERVER_ROUTES: readonly ServerRoute[] = [
  { pattern: '/api/settings' },
  { pattern: '/api/collect-keywords' },
  { pattern: '/api/products' },
  { pattern: '/api/products/:id/listings' },
  { pattern: '/api/products/:id/mark-reviewed' },
  { pattern: '/api/real-estate' },
  { pattern: '/api/deals' },
  { pattern: '/api/notifications' },
  { pattern: '/api/notifications/:id/read' },
  { pattern: '/api/notifications/mark-all-read' },
  { pattern: '/api/products/:id/exclude' },
  { pattern: '/api/products/:id/include' },
  { pattern: '/api/products/:id/manual-price' },
  { pattern: '/api/listings/:id/save' },
]

function matchSegments(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/')
  const got = pathname.split('/')
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (got[i] === '') return null
      params[want[i].slice(1)] = got[i]
    } else if (want[i] !== got[i]) {
      return null
    }
  }
  return params
}

/** The server path for a browser path, or null when no entry matches. */
export function resolveServerPath(routes: readonly ServerRoute[], pathname: string): string | null {
  for (const route of routes) {
    const params = matchSegments(route.pattern, pathname)
    if (!params) continue
    if (!route.serverPath) return pathname.slice('/api'.length)
    return route.serverPath.replace(/:(\w+)/g, (_, name: string) => params[name] ?? '')
  }
  return null
}

export function isServerRoute(pathname: string): boolean {
  return resolveServerPath(SERVER_ROUTES, pathname) !== null
}

/**
 * The server URL a browser request should be rewritten to, or null when Next
 * still serves the path itself. `/api/settings` becomes `{baseUrl}/settings`.
 */
export function serverRouteTarget(pathname: string, search: string, baseUrl: string): URL | null {
  const serverPath = resolveServerPath(SERVER_ROUTES, pathname)
  if (serverPath === null) return null
  return new URL(`${baseUrl.replace(/\/+$/, '')}${serverPath}${search}`)
}
