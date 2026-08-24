// Same normalized title within the same product's listing set - the two
// real cases found live 2026-08-24 both had byte-identical titles (case
// aside), different listing ids, posted close together: a seller reposting
// the same ad rather than a scraper/dedup bug (each row is a genuinely
// distinct Facebook listing id, confirmed live against the DB). Deliberately
// narrow - exact title match only, no price/date fuzzing, to keep the
// false-positive rate low.
export function computeRepostIds(listings: { id: string; title: string }[]): Set<string> {
  const byTitle = new Map<string, string[]>()
  for (const l of listings) {
    const key = l.title.trim().toLowerCase()
    const ids = byTitle.get(key) ?? []
    ids.push(l.id)
    byTitle.set(key, ids)
  }

  const repostIds = new Set<string>()
  for (const ids of byTitle.values()) {
    if (ids.length > 1) ids.forEach((id) => repostIds.add(id))
  }
  return repostIds
}
