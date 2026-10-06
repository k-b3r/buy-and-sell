export interface TavilySearchResult {
  answer: string | null
  results: { title: string; content: string }[]
}

export interface TavilyClient {
  search(query: string): Promise<TavilySearchResult>
}

export function createTavilyClient(apiKey: string): TavilyClient {
  return {
    async search(query: string): Promise<TavilySearchResult> {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, include_answer: true }),
      })
      if (!response.ok) {
        const body = await response.text()
        const err = new Error(`Tavily request failed: ${response.status} ${body}`) as Error & { status: number }
        err.status = response.status
        throw err
      }
      const data = (await response.json()) as { answer?: string | null; results?: { title: string; content: string }[] }
      return { answer: data.answer ?? null, results: data.results ?? [] }
    },
  }
}
