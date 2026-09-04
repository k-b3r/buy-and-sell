import { NextResponse } from 'next/server'
import { markDiscountNotificationRead } from '@/lib/queries'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await markDiscountNotificationRead(Number(id))
  return NextResponse.json({ ok: true })
}
