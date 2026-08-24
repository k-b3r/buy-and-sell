// Open-door icon (a door frame with an arrow exiting through the gap) - used
// wherever the app navigates back to a previous view. Mirrored horizontally
// from the common "log out" icon shape so the arrow points left/back instead
// of right, matching "leaving through the door behind you."
export default function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" />
      <polyline points="8 17 3 12 8 7" />
      <line x1="3" y1="12" x2="15" y2="12" />
    </svg>
  )
}
