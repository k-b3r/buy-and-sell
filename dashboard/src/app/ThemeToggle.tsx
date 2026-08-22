'use client'

import { useLayoutEffect, useState } from 'react'

type Theme = 'light' | 'dark'

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light')

  // The inline script in layout.tsx already set data-theme before paint;
  // this just re-applies it after React Strict Mode's dev-only remount
  // clears attributes JSX doesn't own, and syncs this component's state.
  useLayoutEffect(() => {
    const current = readStoredTheme()
    setTheme(current)
    document.documentElement.setAttribute('data-theme', current)
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      style={{
        background: 'transparent',
        color: 'var(--color-text)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        width: 36,
        height: 36,
        fontSize: '1.1rem',
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  )
}
