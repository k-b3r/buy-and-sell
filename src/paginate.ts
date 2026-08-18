export interface PageCursor {
  raw: string
  pg: number
}

export function extractCursor(html: string): PageCursor | null {
  const match = html.match(/"end_cursor":"((?:[^"\\]|\\.)*)"/)
  if (!match) return null
  try {
    const raw = JSON.parse(`"${match[1]}"`)
    const parsed = JSON.parse(raw) as { pg: number }
    return { raw, pg: parsed.pg }
  } catch {
    return null
  }
}

export function extractLsd(html: string): string | null {
  const match = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)
  return match ? match[1] : null
}

export interface PaginationPage {
  nodes: Record<string, unknown>[]
  nextCursor: PageCursor | null
  hasNextPage: boolean
}

export function parsePaginationResponse(json: string): PaginationPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const feedUnits = (parsed as any)?.data?.marketplace_search?.feed_units
  if (!feedUnits || !Array.isArray(feedUnits.edges) || !feedUnits.page_info) {
    return null
  }
  const nodes = feedUnits.edges
    .filter((edge: any) => edge?.node && typeof edge.node === 'object')
    .map((edge: any) => edge.node as Record<string, unknown>)
  const pageInfo = feedUnits.page_info as { end_cursor: string; has_next_page: boolean }
  let nextCursor: PageCursor | null = null
  try {
    nextCursor = { raw: pageInfo.end_cursor, pg: JSON.parse(pageInfo.end_cursor).pg }
  } catch {
    nextCursor = null
  }
  return { nodes, nextCursor, hasNextPage: pageInfo.has_next_page }
}
