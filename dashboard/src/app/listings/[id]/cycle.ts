// The listing modal masks the URL to /listings/<id> (intercepting route)
// without unmounting the product page underneath - usePathname() in
// ListingsView sees that masked URL, so this pulls the id back out to
// highlight the matching listing while its modal is open.
export function getActiveListingId(pathname: string | null): string | null {
  if (!pathname) return null
  const match = pathname.match(/^\/listings\/([^/]+)$/)
  return match ? match[1] : null
}

export interface CycleTarget {
  prevId: string | null
  nextId: string | null
}

// Wraps around (last -> first, first -> last) - "cycle" per the ask, not a
// bounded prev/next that dead-ends at the list's edges. Returns nulls when
// there's nothing to cycle to: the id list is empty/unavailable (e.g. the
// modal was reached by a direct URL, not from a product's listing list) or
// currentId isn't in it, or there's only one listing to begin with.
export function getCycleTarget(ids: string[], currentId: string): CycleTarget {
  const index = ids.indexOf(currentId)
  if (index === -1 || ids.length < 2) return { prevId: null, nextId: null }
  return {
    prevId: ids[(index - 1 + ids.length) % ids.length],
    nextId: ids[(index + 1) % ids.length],
  }
}
