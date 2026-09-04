import { NextResponse } from 'next/server'
import { getListingProductId } from '@/lib/queries'
import { revalidateTag } from 'next/cache'

// Hands off to the POST /refresh route on server/ (server/routes/refresh.ts,
// registered in server/index.ts) running on the box that actually has
// Playwright/Chromium (Vercel, where this dashboard is deployed, can't
// reasonably run a full browser session) - see server/app.ts for why that's
// a generic router rather than a single-purpose service. This route is
// already gated by proxy.ts's blanket auth check (everything except /login
// and /api/login requires the dashboard cookie); REFRESH_API_KEY below is a
// second, separate secret for the server-to-server hop to that other box,
// never exposed to the browser.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const refreshServerUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!refreshServerUrl || !apiKey) {
    return NextResponse.json({ error: 'refresh service not configured' }, { status: 503 })
  }

  const res = await fetch(`${refreshServerUrl}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ id }),
  })
  const body = await res.json()

  // Page data is cached (see lib/cachedQueries.ts) since it rarely changes
  // on its own - this refresh just happened, so bust the listing/product/list
  // caches now instead of waiting out the TTL. { expire: 0 } for immediate
  // expiry, not the "max" stale-while-revalidate default - the very next
  // page load after a refresh should show fresh data, not last-known-stale.
  if (res.ok) {
    revalidateTag(`listing:${id}`, { expire: 0 })
    revalidateTag('products-list', { expire: 0 })
    const productId = await getListingProductId(id)
    if (productId != null) revalidateTag(`product:${productId}`, { expire: 0 })
  }

  return NextResponse.json(body, { status: res.status })
}
