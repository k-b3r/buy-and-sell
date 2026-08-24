import type { CSSProperties } from 'react'

// Shared "back" icon-button look - used by BackLink (plain href navigation)
// and by Modal's back-to-listings button (router.back(), not a real href,
// so it can't be a Link) - kept as one source of truth. Matches the
// prev/next nav buttons' circular style so all "move between views" controls
// read as one family.
export const backIconStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 40,
  height: 40,
  borderRadius: '50%',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontSize: '1.3rem',
  lineHeight: 1,
  textDecoration: 'none',
  cursor: 'pointer',
}
