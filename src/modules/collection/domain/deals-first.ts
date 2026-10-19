export function putDealsFirst<T extends { id: string }>(deals: T[], backlog: T[], limit: number): T[] {
  const dealIds = new Set(deals.map((d) => d.id))
  return [...deals, ...backlog.filter((c) => !dealIds.has(c.id))].slice(0, limit)
}
