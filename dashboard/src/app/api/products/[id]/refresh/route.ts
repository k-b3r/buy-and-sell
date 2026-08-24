import { NextResponse } from 'next/server'

// Hands off to POST /refresh-product on server/ (server/routes/refreshProduct.ts)
// - starts a bulk job checking every not-yet-sold listing under this product,
// same auth/proxy pattern as api/listings/[id]/refresh (see that route for why
// this hop exists and what REFRESH_API_KEY is for). Unlike that route, the
// server responds as soon as the job STARTS, not when it finishes - progress
// is polled separately via GET /api/refresh-job.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const refreshServerUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!refreshServerUrl || !apiKey) {
    return NextResponse.json({ error: 'refresh service not configured' }, { status: 503 })
  }

  const res = await fetch(`${refreshServerUrl}/refresh-product`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ productId: Number(id) }),
  })
  const body = await res.json()
  return NextResponse.json(body, { status: res.status })
}
