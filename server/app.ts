import { createServer, type Server } from 'node:http'

export interface RouteResult {
  statusCode: number
  body: unknown
}

export type RouteHandler = (body: unknown) => Promise<RouteResult>

// Key format: "METHOD /path" (e.g. "POST /refresh") - exact match only, no
// path params. Every route on this server is body-driven (ids/etc arrive in
// the JSON body, not the URL), which is enough for what's here and what's
// anticipated - a path-param matcher can be added if a future use case
// genuinely needs one, not before.
export type RouteTable = Record<string, RouteHandler>

// Pure routing/auth/JSON-parsing core, no Node http types involved - testable
// directly without spinning up a real server or faking IncomingMessage/
// ServerResponse. createApp below is just a thin Node adapter around this.
export async function handleRequest(
  routes: RouteTable,
  apiKey: string,
  method: string | undefined,
  url: string | undefined,
  authHeader: string | undefined,
  rawBody: string,
): Promise<RouteResult> {
  const handler = routes[`${method} ${url}`]
  if (!handler) {
    return { statusCode: 404, body: { error: 'not found' } }
  }
  // Every route on this server is private - it's a personal companion
  // service to the collector scripts, nothing here is meant to be public.
  // One shared secret for all routes, checked here once, so a new route
  // never has to reimplement auth itself.
  if (authHeader !== `Bearer ${apiKey}`) {
    return { statusCode: 401, body: { error: 'unauthorized' } }
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return { statusCode: 400, body: { error: 'invalid JSON body' } }
  }
  return handler(body)
}

// Generic JSON-in/JSON-out HTTP app - register a route table, get a plain
// Node http.Server back. New use cases add an entry to the route table
// passed in at the call site (see index.ts), not a change to this file.
export function createApp(apiKey: string, routes: RouteTable): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      const result = await handleRequest(routes, apiKey, req.method, req.url, req.headers.authorization, raw)
      res.writeHead(result.statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })
}
