'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { exclusionLabel, includeExplanation } from '@/lib/exclusionReasons'

// Product page notice for a product price lookup skips (BUY-36), with the
// undo. Renders nothing unless the product is excluded and
// pricing.exclusions_ui_enabled is on (show).
export default function PricingExclusion({
  productId,
  reason,
  show,
}: {
  productId: number
  reason: string | null
  show: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function include() {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/products/${productId}/include`, { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      router.refresh()
    } catch {
      setError('Could not include this product. Try again.')
      setPending(false)
    }
  }

  if (!show || !reason) return null
  return (
    <section
      style={{
        margin: '1rem 0',
        padding: '0.75rem 1rem',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        background: 'var(--color-surface)',
      }}
    >
      <p style={{ margin: 0 }}>
        <strong>Pricing excluded:</strong>{' '}
        <Link href={`/excluded?reason=${encodeURIComponent(reason)}`}>{exclusionLabel(reason)}</Link>
      </p>
      <p style={{ margin: '0.25rem 0 0.5rem', fontSize: '0.9em', opacity: 0.8 }}>{includeExplanation(reason)}</p>
      <button type="button" onClick={include} disabled={pending}>
        {pending ? 'Including…' : 'Include in pricing'}
      </button>
      {error && <p style={{ color: 'var(--color-danger)', margin: '0.5rem 0 0' }}>{error}</p>}
    </section>
  )
}
