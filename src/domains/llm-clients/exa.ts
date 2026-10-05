import { createClientPool } from './client-pool'
import { isCreditsError } from './error-classification'

export interface ExaClient {
  searchStructured(query: string, systemPrompt: string, schema: object): Promise<unknown>
}

// Env var scheme changed 2026-08-31: EXA_API_KEY/ALT_EXA_API_KEY (fixed 2)
// replaced with numbered EXA_API_KEY0, EXA_API_KEY1, ... - reads
// sequentially until the next index is unset, so the pool can grow/shrink
// with no code change. Single source of truth for every worker that uses
// Exa (price-lookup, extract-products, verify-discount-notifications).
export function loadExaApiKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = []
  for (let i = 0; ; i++) {
    const key = env[`EXA_API_KEY${i}`]
    if (!key) break
    keys.push(key)
  }
  return keys
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

// Switches only on Exa's 402 credits signal (isCreditsError), not on a 429.
// Switching contract: createClientPool.
export function createFallbackExaClient(clients: ExaClient[]): ExaClient {
  const run = createClientPool(clients, { provider: 'Exa', isExhausted: isCreditsError })
  return {
    searchStructured: (query, systemPrompt, schema) =>
      run((client) => client.searchStructured(query, systemPrompt, schema)),
  }
}
