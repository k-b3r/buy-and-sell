'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import HamburgerIcon from './HamburgerIcon'

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
//
// Below site-header-nav's breakpoint (globals.css) the pill row can't fit
// the header anymore, so this renders a hamburger button instead that opens
// the same links as a dropdown - .nav-hamburger/.nav-links/.nav-links-open
// are the CSS-class side of that swap, since inline styles can't be
// overridden by a media query.
export default function NavLinks() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    // No position style here on purpose - nav-links (position:absolute,
    // left:0/right:0) needs its containing block to stay site-header
    // (position:sticky) so the dropdown spans the full header width. Giving
    // this wrapper its own position:relative would make it the containing
    // block instead, shrinking the dropdown to the hamburger button's width.
    <div ref={containerRef}>
      <button
        type="button"
        className="nav-hamburger"
        aria-label="Toggle navigation menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <HamburgerIcon />
      </button>
      <nav className={`nav-links${open ? ' nav-links-open' : ''}`}>
        {NAV_LINKS.map(({ href, label }) => (
          <Link key={href} href={href} className={`nav-pill${pathname === href ? ' nav-pill-active' : ''}`}>
            {label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
