// Repost identity: same normalized title within the same product's listing
// set - the two real cases found live 2026-08-24 both had byte-identical
// titles (case aside), different listing ids, posted close together: a
// seller reposting the same ad rather than a scraper/dedup bug (each row is a
// genuinely distinct Facebook listing id, confirmed live against the DB).
// Deliberately narrow - exact title match only, no price/date fuzzing, to
// keep the false-positive rate low. An untitled listing (rare) keys on its
// own id, so untitled listings never merge with each other.
//
// One rule, two sides: repostKey (JS, the product page's repost badge) and
// repostKeySql (the deals page's collapse to one row per repost group).
// tests/integration/repost.int.test.ts checks they agree on shared fixtures.
// Both strip surrounding whitespace with the same regex (Postgres trim()
// strips plain spaces only, so it can't be used).

// JS's \s set spelled out (tabs, newlines, NBSP, Unicode spaces), so the one
// pattern means the same thing to both regex engines.
const WHITESPACE_CLASS = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
const EDGE_WHITESPACE = `^${WHITESPACE_CLASS}+|${WHITESPACE_CLASS}+$`
const EDGE_WHITESPACE_RE = new RegExp(EDGE_WHITESPACE, 'g')

export function repostKey(listing: { id: string; title: string | null }): string {
  return listing.title === null ? listing.id : listing.title.replace(EDGE_WHITESPACE_RE, '').toLowerCase()
}

export function repostKeySql(titleColumn: string, idColumn: string): string {
  return `COALESCE(lower(regexp_replace(${titleColumn}, '${EDGE_WHITESPACE}', '', 'g')), ${idColumn})`
}

// Every listing that shares its repost key with another one in the set -
// both copies get flagged, not just the later one.
export function computeRepostIds(listings: { id: string; title: string | null }[]): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const l of listings) {
    const key = repostKey(l)
    byKey.set(key, [...(byKey.get(key) ?? []), l.id])
  }

  const repostIds = new Set<string>()
  for (const ids of byKey.values()) {
    if (ids.length > 1) ids.forEach((id) => repostIds.add(id))
  }
  return repostIds
}
