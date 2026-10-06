// Decorative square listing photo for notification rows. A CSS background
// rather than <img>: listing photos are remote CDN URLs and next/image has no
// remotePatterns configured, so this avoids both the optimizer and another
// no-img-element lint exception.
export default function ListingThumb({ photoUrl, size }: { photoUrl: string | null; size: number }) {
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        flexShrink: 0,
        backgroundColor: 'var(--color-border)',
        backgroundImage: photoUrl ? `url(${JSON.stringify(photoUrl)})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    />
  )
}
