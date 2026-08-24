import type { CSSProperties } from 'react'

// Visual style only - no position/bottom/right here. The standalone listing
// page anchors this fixed to the viewport (no modal box to anchor to); the
// modal anchors it absolute to its own box instead, so it stays "in" the
// modal rather than floating over the backdrop at the screen's corner.
export const marketplaceButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: '50%',
  border: 'none',
  // Facebook's own brand blue, not this app's neutral palette - deliberate
  // exception so the button reads as "hand off to Facebook" at a glance.
  background: '#1877f2',
  color: '#ffffff',
  textDecoration: 'none',
  boxShadow: '0 4px 12px var(--color-overlay)',
}
