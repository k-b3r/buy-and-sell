import type { MetadataRoute } from 'next'

// Personal, password-gated tool - nothing here should ever show up in search
// results, even though the auth gate already blocks crawlers from seeing
// real content. Paired with the noindex directive in layout.tsx's metadata
// (robots.txt alone isn't authoritative - a bot that ignores it, or a page
// already indexed before this existed, needs the meta tag too).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  }
}
