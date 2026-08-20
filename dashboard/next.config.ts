import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // This app has its own pnpm-lock.yaml separate from the root repo's —
  // pin the workspace root explicitly so Turbopack doesn't guess wrong.
  turbopack: {
    root: path.join(__dirname),
  },
}

export default nextConfig
