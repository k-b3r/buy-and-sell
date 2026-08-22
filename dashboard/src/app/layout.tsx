import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google'
import Link from 'next/link'
import ThemeToggle from './ThemeToggle'
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
}

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
        <header className="site-header">
          <Link href="/" className="wordmark">
            Ledger
          </Link>
          <ThemeToggle />
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  )
}
