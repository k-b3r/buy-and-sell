import { NextResponse } from 'next/server'

// Proxies POST /refresh-job/cancel on server/ (server/routes/refreshJobCancel.ts)
// - see api/listings/[id]/refresh for the auth/hop pattern this follows.
// Cancellation is cooperative (the batch loop only checks between listings),
// so this doesn't stop things instantly - the next poll of GET /api/refresh-job
// will show status:'cancelled' once the loop notices.
export async function POST() {
  const refreshServerUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!refreshServerUrl || !apiKey) {
    return NextResponse.json({ error: 'refresh service not configured' }, { status: 503 })
  }

  const res = await fetch(`${refreshServerUrl}/refresh-job/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  const body = await res.json()
  return NextResponse.json(body, { status: res.status })
}
