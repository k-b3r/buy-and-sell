// Typed fetch helper for the VPS server's resource routes (GET /settings,
// PUT /collect-keywords, ...). Replaces the single POST /query rpc() in
// queries.ts one feature at a time.
//
// SERVER-ONLY. Reads REFRESH_API_KEY and must never be imported by a client
// component: the browser calls same-origin /api/* and never sees the key.

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON-encoded as the request body. */
  body?: unknown
}

// Ambient state (env, fetch) is a parameter so tests can fake both.
interface ApiDeps {
  env: Record<string, string | undefined>
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

const defaultDeps = (): ApiDeps => ({ env: process.env, fetch })

/**
 * Calls the server and returns its parsed JSON body. Throws on a non-2xx
 * response (detail stays in the server log: its errors are opaque by design).
 */
export async function api<T>(path: string, options: ApiOptions = {}, deps: ApiDeps = defaultDeps()): Promise<T> {
  const baseUrl = deps.env.REFRESH_SERVER_URL
  const apiKey = deps.env.REFRESH_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('REFRESH_SERVER_URL/REFRESH_API_KEY not set - the dashboard cannot reach the server without them')
  }

  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const res = await deps.fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // Caching is the server's job (and cachedQueries.ts's until it moves
    // there); Next's fetch cache would key on URL+body and duplicate it.
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status}`)
  }
  return (await res.json()) as T
}
