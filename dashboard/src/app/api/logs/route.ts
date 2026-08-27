import { NextResponse } from 'next/server'

// Proxies POST /logs on server/ (server/routes/logs.ts) - see
// api/listings/[id]/refresh for the auth/hop pattern this follows. Forwards
// the client's { worker, offset } body through unchanged.
export async function POST(request: Request) {
  const refreshServerUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!refreshServerUrl || !apiKey) {
    return NextResponse.json({ error: 'refresh service not configured' }, { status: 503 })
  }

  const requestBody = await request.text()
  const res = await fetch(`${refreshServerUrl}/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: requestBody,
  })
  const body = await res.json()
  return NextResponse.json(body, { status: res.status })
}
