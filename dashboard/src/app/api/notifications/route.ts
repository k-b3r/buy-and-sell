import { NextResponse } from 'next/server'
import { getDiscountNotifications, getUnreadDiscountNotificationCount } from '@/lib/queries'

export async function GET() {
  const [notifications, unreadCount] = await Promise.all([
    getDiscountNotifications(),
    getUnreadDiscountNotificationCount(),
  ])
  return NextResponse.json({ notifications, unreadCount })
}
