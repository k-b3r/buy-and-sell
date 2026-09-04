import { NextResponse } from 'next/server'
import { markAllDiscountNotificationsRead } from '@/lib/queries'

export async function POST() {
  await markAllDiscountNotificationsRead()
  return NextResponse.json({ ok: true })
}
