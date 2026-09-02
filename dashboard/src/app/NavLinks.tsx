'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_LINKS = [
  { href: '/deals', label: 'Deals' },
  { href: '/admin/logs', label: 'Workers' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/needs-review', label: 'Needs Review' },
  { href: '/admin/settings', label: 'Settings' },
] as const

// Client component (needs usePathname) split out of layout.tsx so the rest
// of the header - a server component - doesn't have to become one just for
// this. Exact-match, not startsWith: none of these five routes has a nested
// page today, and /admin/logs vs /admin/settings would both wrongly light
// up under a shared "/admin" prefix check.
export default function NavLinks() {
  const pathname = usePathname()
  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', pointerEvents: 'auto' }}>
      {NAV_LINKS.map(({ href, label }) => (
        <Link key={href} href={href} className={`nav-pill${pathname === href ? ' nav-pill-active' : ''}`}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
