import { NextResponse } from 'next/server'

// Hands off to refresh-server.ts running on the box that actually has
// Playwright/Chromium (Vercel, where this dashboard is deployed, can't
// reasonably run a full browser session) - see server/refresh-server.ts for
// why this is a separate service rather than something this route does
// itself. This route is already gated by proxy.ts's blanket auth check
// (everything except /login and /api/login requires the dashboard cookie);
// REFRESH_API_KEY below is a second, separate secret for the server-to-server
// hop to that other box, never exposed to the browser.
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
  return NextResponse.json(body, { status: res.status })
}
