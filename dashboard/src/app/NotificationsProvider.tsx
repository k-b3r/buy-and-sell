'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import type { DiscountNotification } from '@/lib/queries'

interface NotificationsContextValue {
  notifications: DiscountNotification[]
  unreadCount: number
  markRead: (id: number) => void
  markAllRead: () => void
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

const POLL_INTERVAL_MS = 60000

// Single poll loop shared by NotificationBell (persistent dropdown/badge) and
// NotificationToasts (ephemeral pop-ups on arrival) - both need the same
// /api/notifications data, and two independent 60s pollers hitting the same
// endpoint would double the requests and could drift out of sync with each
// other. This app has no websocket/SSE infra; a 60s lag on a personal
// single-user tool is a non-issue.
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<DiscountNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)

  async function refresh() {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications)
      setUnreadCount(data.unreadCount)
    } catch {
      // Transient fetch failure - next poll tick retries, nothing to surface here.
    }
  }

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  function markRead(id: number) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)))
    setUnreadCount((prev) => Math.max(0, prev - 1))
    fetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {})
  }

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })))
    setUnreadCount(0)
    fetch('/api/notifications/mark-all-read', { method: 'POST' }).catch(() => {})
  }

  return (
    <NotificationsContext.Provider value={{ notifications, unreadCount, markRead, markAllRead }}>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationsProvider')
  return ctx
}
