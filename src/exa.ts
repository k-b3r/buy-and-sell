export interface ExaClient {
  searchStructured(query: string, systemPrompt: string, schema: object): Promise<unknown>
}

export function createExaClient(apiKey: string): ExaClient {
  return {
    async searchStructured(query: string, systemPrompt: string, schema: object): Promise<unknown> {
      const response = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: 5,
          systemPrompt,
          outputSchema: schema,
          contents: { highlights: true },
        }),
      })
      if (!response.ok) {
        const body = await response.text()
        const err = new Error(`Exa request failed: ${response.status} ${body}`) as Error & { status: number }
        err.status = response.status
        throw err
      }
      const json = (await response.json()) as { output?: { content?: unknown } }
      return json.output?.content
    },
  }
}
