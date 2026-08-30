import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { getDiscountNotifications, getUnreadDiscountNotificationCount } from '@/lib/queries'

export async function GET() {
  const db = getPool()
  const [notifications, unreadCount] = await Promise.all([getDiscountNotifications(db), getUnreadDiscountNotificationCount(db)])
  return NextResponse.json({ notifications, unreadCount })
}
