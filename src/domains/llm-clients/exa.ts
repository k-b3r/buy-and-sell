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
      // The full response (results, output.content, output.grounding,
      // costDollars, etc.) is returned, not just output.content — callers
      // want the citations/confidence too, and the raw body is worth keeping
      // for later enrichment/analysis, not just the parsed price fields.
      return await response.json()
    },
  }
}

// 402 is Exa's credits-exhausted signal (confirmed live 2026-08-28: real
// error body tags NO_MORE_CREDITS) - distinct from Gemini/Groq's 429 quota
// errors, but the same "this key is done for now, not a real failure"
// shape.
export function isExaCreditsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 402
}

// Same permanent-switch-on-exhaustion pattern as createFallbackGeminiClient/
// createFallbackGroqClient - once a key's credits are known to be gone,
// there's no reason to try it again this run. Any other error (network
// failure, malformed response) is not a credits signal and is rethrown
// immediately without switching.
export function createFallbackExaClient(clients: ExaClient[]): ExaClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: ExaClient) => Promise<T>): Promise<T> {
    while (currentIndex < clients.length) {
      try {
        return await call(clients[currentIndex])
      } catch (err) {
        if (isExaCreditsError(err) && currentIndex < clients.length - 1) {
          currentIndex += 1
          continue
        }
        throw err
      }
    }
    throw new Error('all Exa clients exhausted')
  }

  return {
    searchStructured: (query, systemPrompt, schema) => withFallback((client) => client.searchStructured(query, systemPrompt, schema)),
  }
}
