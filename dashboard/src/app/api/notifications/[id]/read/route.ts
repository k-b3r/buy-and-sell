import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { markDiscountNotificationRead } from '@/lib/queries'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await markDiscountNotificationRead(getPool(), Number(id))
  return NextResponse.json({ ok: true })
}
