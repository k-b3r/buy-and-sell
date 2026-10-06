import { createClientPool } from './client-pool'
import { isCreditsError, isQuotaError } from './error-classification'

export interface OpenRouterClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createOpenRouterClient(apiKey: string, model = 'deepseek/deepseek-v4-flash-0731'): OpenRouterClient {
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema },
          },
        }),
      })
      if (!response.ok) {
        const body = await response.text()
        const err = new Error(`OpenRouter request failed: ${response.status} ${body}`) as Error & { status: number }
        err.status = response.status
        throw err
      }
      const data = (await response.json()) as { choices: { message: { content: string } }[] }
      const content = data.choices[0]?.message?.content
      if (!content) {
        throw new Error('OpenRouter response contained no content')
      }
      return JSON.parse(content)
    },
  }
}

// A 429 rate limit or a 402 insufficient-credits both mean "this key is done
// for now", so either one switches keys. Switching contract: createClientPool.
export function createFallbackOpenRouterClient(clients: OpenRouterClient[]): OpenRouterClient {
  const run = createClientPool(clients, {
    provider: 'OpenRouter',
    isExhausted: (err) => isQuotaError(err) || isCreditsError(err),
  })
  return { generateJson: (prompt, schema) => run((client) => client.generateJson(prompt, schema)) }
}
