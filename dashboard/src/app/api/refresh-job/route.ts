import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'

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

  // Bulk job finished (or was cancelled mid-way, which can still have
  // written some completed listings) - bust this product's cached page and
  // the list page rather than waiting out the TTL. Fine to call on every
  // poll that lands here since revalidateTag is idempotent; the client
  // stops polling once it observes a non-running status anyway.
  const job = body as { productId?: number; status?: string } | null
  if (job && (job.status === 'completed' || job.status === 'cancelled') && job.productId != null) {
    revalidateTag(`product:${job.productId}`, { expire: 0 })
    revalidateTag('products-list', { expire: 0 })
  }

  return NextResponse.json(body, { status: res.status })
}
