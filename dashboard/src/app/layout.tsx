import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google'
import Link from 'next/link'
import ThemeToggle from './ThemeToggle'
import NotificationBell from './NotificationBell'
import NotificationToasts from './NotificationToasts'
import { NotificationsProvider } from './NotificationsProvider'
import './globals.css'

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-heading', display: 'swap' })
const inter = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' })
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata = {
  title: 'Ledger — Buy & Sell Dashboard',
  description: 'Price-tracking dashboard for collected marketplace listings',
  // Belt-and-suspenders with robots.ts - a meta tag is authoritative even
  // for a bot that ignores robots.txt, or a page that got indexed before
  // either of these existed.
  robots: { index: false, follow: false },
}

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  modal: React.ReactNode
}) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <NotificationsProvider>
          <header className="site-header">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <Link href="/" className="wordmark">
                Ledger
              </Link>
            </div>
            {/* Absolutely positioned within the same max-width:1100px column
                .page uses, so the nav lines up with the page title's left edge
                at any viewport width instead of the header's own (wider,
                fixed-padding) row - site-header's position:sticky already
                gives this its containing block. pointerEvents:none on the
                wrapper keeps clicks passing through to Ledger/right-side links
                when the column is narrower than the full header width. */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                maxWidth: 1100,
                margin: '0 auto',
                padding: '0 2rem',
                display: 'flex',
                alignItems: 'center',
                pointerEvents: 'none',
              }}
            >
              <nav style={{ display: 'flex', alignItems: 'center', gap: 16, pointerEvents: 'auto' }}>
                <Link href="/admin/logs" style={{ textDecoration: 'none', fontWeight: 500, color: 'var(--color-text)' }}>
                  Workers
                </Link>
                <Link href="/analytics" style={{ textDecoration: 'none', fontWeight: 500, color: 'var(--color-text)' }}>
                  Analytics
                </Link>
                <Link href="/needs-review" style={{ textDecoration: 'none', fontWeight: 500, color: 'var(--color-text)' }}>
                  Needs Review
                </Link>
              </nav>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Link href="/saved" style={{ textDecoration: 'none', fontWeight: 500, color: 'var(--color-text)' }}>
                My Saved Listings
              </Link>
              <NotificationBell />
              <ThemeToggle />
            </div>
          </header>
          <main className="page">{children}</main>
          {modal}
          <NotificationToasts />
        </NotificationsProvider>
      </body>
    </html>
  )
}
