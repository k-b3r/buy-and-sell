import { NextResponse } from 'next/server'

// Polled by RefreshProductButton while a bulk job is running. Proxies
// GET /refresh-job on server/ (server/routes/refreshJob.ts) - see
// api/listings/[id]/refresh for the auth/hop pattern this follows.
export async function GET() {
  const refreshServerUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!refreshServerUrl || !apiKey) {
    return NextResponse.json({ error: 'refresh service not configured' }, { status: 503 })
  }

  const res = await fetch(`${refreshServerUrl}/refresh-job`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  const body = await res.json()
  return NextResponse.json(body, { status: res.status })
}
