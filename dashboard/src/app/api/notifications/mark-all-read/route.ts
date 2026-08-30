import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { markAllDiscountNotificationsRead } from '@/lib/queries'

export async function POST() {
  await markAllDiscountNotificationsRead(getPool())
  return NextResponse.json({ ok: true })
}
