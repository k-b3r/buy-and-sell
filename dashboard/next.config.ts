import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // This app has its own pnpm-lock.yaml separate from the root repo's —
  // pin the workspace root explicitly so Turbopack doesn't guess wrong.
  turbopack: {
    root: path.join(__dirname),
  },
  // public/docs/index.html only serves as a static file at that exact path —
  // bare /docs falls through to the app's own catch-all route otherwise.
  async rewrites() {
    return [{ source: '/docs', destination: '/docs/index.html' }]
  },
}

export default nextConfig
