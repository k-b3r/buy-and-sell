export interface PageCursor {
  raw: string
  pg: number
}

export function extractCursor(html: string): PageCursor | null {
  const match = html.match(/"end_cursor":"((?:[^"\\]|\\.)*)"/)
  if (!match) return null
  const raw = JSON.parse(`"${match[1]}"`)
  const parsed = JSON.parse(raw) as { pg: number }
  return { raw, pg: parsed.pg }
}

export function extractLsd(html: string): string | null {
  const match = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)
  return match ? match[1] : null
}
